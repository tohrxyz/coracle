import {partition, concat, prop, uniqBy, identity, without, assoc} from "ramda"
import {doPipe, batch} from "hurdak"
import {now, writable} from "@coracle.social/lib"
import {
  Tags,
  getIdOrAddress,
  getIdAndAddress,
  getIdFilters,
  guessFilterDelta,
} from "@coracle.social/util"
import {race} from "src/util/misc"
import {info} from "src/util/logger"
import {LOCAL_RELAY_URL, noteKinds, reactionKinds, repostKinds} from "src/util/nostr"
import type {DisplayEvent} from "src/engine/notes/model"
import type {Event} from "src/engine/events/model"
import {sortEventsDesc, unwrapRepost} from "src/engine/events/utils"
import {isEventMuted, isDeleted} from "src/engine/events/derived"
import type {DynamicFilter, RelayFilters} from "src/engine/network/utils"
import {compileFilters, addRepostFilters, getRelayFilters} from "src/engine/network/utils"
import {tracker, load, subscribe} from "./executor"
import {MultiCursor} from "./cursor"

export type FeedOpts = {
  relays: string[]
  filters: DynamicFilter[]
  onEvent?: (e: Event) => void
  anchor?: string
  skipCache?: boolean
  skipPlatform?: boolean
  shouldDefer?: boolean
  shouldListen?: boolean
  shouldBuffer?: boolean
  shouldHideReplies?: boolean
  shouldLoadParents?: boolean
}

export class FeedLoader {
  since = now()
  stopped = false
  subs: Array<{close: () => void}> = []
  buffer = writable<Event[]>([])
  notes = writable<DisplayEvent[]>([])
  parents = new Map<string, DisplayEvent>()
  reposts = new Map<string, Event[]>()
  replies = new Map<string, Event[]>()
  deferred: Event[] = []
  cursor: MultiCursor
  ready: Promise<void>
  isEventMuted = isEventMuted.get()
  isDeleted = isDeleted.get()

  constructor(readonly opts: FeedOpts) {
    const filters = compileFilters(opts.filters)
    const relayFilters = getRelayFilters(filters, {
      forceRelays: opts.relays,
      skipPlatform: opts.skipPlatform,
    }).map(([relay, filters]): RelayFilters => [relay, addRepostFilters(filters)])

    if (false && !opts.skipCache) {
      relayFilters.push([LOCAL_RELAY_URL, addRepostFilters(filters)])
    }

    // No point in subscribing if we have an end date
    if (opts.shouldListen && !opts.filters.every(prop("until"))) {
      this.addSubs(
        relayFilters.map(([relay, filters]) =>
          subscribe({
            relays: [relay],
            skipCache: true,
            filters: filters.map(assoc("since", this.since)),
            onEvent: batch(300, (events: Event[]) => {
              events = this.discardEvents(events)

              if (opts.shouldLoadParents) {
                this.loadParents(events)
              }

              if (opts.shouldBuffer) {
                this.buffer.update($buffer => $buffer.concat(events))
              } else {
                this.addToFeed(events, {prepend: true})
              }
            }),
          }),
        ),
      )
    }

    this.cursor = new MultiCursor({
      relayFilters,
      onEvent: batch(100, events => {
        if (opts.shouldLoadParents) {
          this.loadParents(this.discardEvents(events))
        }
      }),
    })

    const remoteSubs = this.addSubs(this.cursor.load(50))

    // Wait until a good number of subscriptions have completed to reduce the chance of
    // out of order notes
    this.ready = race(
      0.4,
      remoteSubs.map(s => new Promise(r => s.emitter.on("complete", r))),
    )
  }

  discardEvents(events) {
    // Be more tolerant when looking at communities
    const strict = this.opts.filters.some(f => f["#a"])

    return events.filter(e => {
      if (this.isDeleted(e)) {
        return false
      }

      if (this.isEventMuted(e, strict)) {
        return false
      }

      if (this.opts.shouldHideReplies && Tags.fromEvent(e).parent()) {
        return false
      }

      if (getIdOrAddress(e) === this.opts.anchor) {
        return false
      }

      return true
    })
  }

  loadParents = notes => {
    // Add notes to parents too since they might match
    for (const e of notes) {
      this.parents.set(e.id, e)
    }

    const parentIds = notes
      .filter(e => !repostKinds.includes(e.kind) && !this.isEventMuted(e))
      .map(e => Tags.fromEvent(e).parent()?.value())
      .filter(identity)

    if (parentIds.length > 0) {
      load({
        relays: this.opts.relays,
        filters: getIdFilters(parentIds),
        onEvent: batch(100, events => {
          for (const e of this.discardEvents(events)) {
            this.parents.set(e.id, e)
          }
        }),
      })
    }
  }

  // Control

  addSubs(subs) {
    for (const sub of subs) {
      this.subs.push(sub)

      sub.emitter.on("complete", () => {
        this.subs = without([sub], this.subs)
      })
    }

    return subs
  }

  stop() {
    this.stopped = true

    for (const sub of this.subs) {
      sub.close()
    }
  }

  // Feed building

  buildFeedChunk = (notes: Event[]) => {
    const seen = new Set(this.notes.get().map(getIdOrAddress))
    const parents = []

    // Sort first to make sure we get the latest version of replaceable events, then
    // after to make sure notes replaced by their parents are in order.
    return sortEventsDesc(
      uniqBy(
        prop("id"),
        sortEventsDesc(notes)
          .map((e: Event) => {
            // If we have a repost, use its contents instead
            if (repostKinds.includes(e.kind)) {
              const wrappedEvent = unwrapRepost(e)

              if (wrappedEvent) {
                const reposts = this.reposts.get(wrappedEvent.id) || []

                this.reposts.set(wrappedEvent.id, [...reposts, e])

                tracker.copy(e.id, wrappedEvent.id)

                e = wrappedEvent
              }
            }

            // Keep track of replies
            if (noteKinds.includes(e.kind)) {
              const parentId = Tags.fromEvent(e).parent()?.value()
              const replies = this.replies.get(parentId) || []

              this.replies.set(parentId, [...replies, e])
            }

            // If we have a parent, show that instead, with replies grouped underneath
            while (true) {
              const parentId = Tags.fromEvent(e).parent()?.value()

              if (!parentId) {
                break
              }

              const parent = this.parents.get(parentId)

              if (!parent) {
                break
              }

              e = parent
            }

            return e
          })
          .concat(parents)
          // If we've seen this note or its parent, don't add it again
          .filter(e => {
            if (seen.has(getIdOrAddress(e))) return false
            if (repostKinds.includes(e.kind)) return false
            if (reactionKinds.includes(e.kind)) return false

            seen.add(getIdOrAddress(e))

            return true
          })
          .map((e: DisplayEvent) => {
            e.replies = getIdAndAddress(e).flatMap(k => this.replies.get(k) || [])
            e.reposts = getIdAndAddress(e).flatMap(k => this.reposts.get(k) || [])

            return e
          }),
      ),
    )
  }

  addToFeed = (notes: Event[], {prepend = false} = {}) => {
    this.notes.update($notes => {
      const chunk = this.buildFeedChunk(notes)
      const combined = prepend ? [...chunk, ...$notes] : [...$notes, ...chunk]

      return uniqBy(prop("id"), combined)
    })
  }

  subscribe = f => this.notes.subscribe(f)

  // Loading

  async load(n) {
    await this.ready

    if (this.cursor.done()) {
      return
    }

    info(`Loading ${n} more events`, {
      filters: this.opts.filters,
      relays: this.opts.relays,
    })

    const [subs, events] = this.cursor.take(n)

    this.addSubs(subs)

    this.addToFeed(
      doPipe(this.discardEvents(events), [
        concat(this.deferred.splice(0)),
        this.deferOrphans,
        this.deferAncient,
      ]),
    )
  }

  loadBuffer() {
    this.buffer.update($buffer => {
      this.addToFeed($buffer)

      return []
    })
  }

  deferOrphans = (notes: Event[]) => {
    if (!this.opts.shouldLoadParents || this.opts.shouldDefer === false) {
      return notes
    }

    // If something has a parent id but we haven't found the parent yet, skip it until we have it.
    const [ok, defer] = partition(e => {
      const parent = Tags.fromEvent(e).parent()

      return !parent || this.parents.has(parent.value())
    }, notes)

    setTimeout(() => this.addToFeed(defer), 3000)

    return ok
  }

  deferAncient = (notes: Event[]) => {
    if (this.opts.shouldDefer === false) {
      return notes
    }

    // Sometimes relays send very old data very quickly. Pop these off the queue and re-add
    // them after we have more timely data. They still might be relevant, but order will still
    // be maintained since everything before the cutoff will be deferred the same way.
    const since = now() - guessFilterDelta(this.opts.filters)
    const [ok, defer] = partition(e => e.created_at > since, notes)

    setTimeout(() => this.addToFeed(defer), 5000)

    return ok
  }
}
