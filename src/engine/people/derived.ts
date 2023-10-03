import {defaultTo, filter} from "ramda"
import {user} from "src/engine/session/derived"
import {people} from "./state"
import {personHasName, getPeopleSearch, getMutes, getFollows, getNetwork} from "./utils"

export const peopleWithName = people.derived(filter(personHasName))

export const searchPeople = peopleWithName.derived(getPeopleSearch)

export const derivePerson = pubkey => people.key(pubkey).derived(defaultTo({pubkey}))

export const mutes = user.derived(getMutes)

export const follows = user.derived(getFollows)

export const network = user.derived(getNetwork)

export const deriveMuted = (value: string) => mutes.derived(s => s.has(value))

export const deriveFollowing = (pubkey: string) => follows.derived(s => s.has(pubkey))

export const possibleImposters = peopleWithName.throttle(1000).derived($people => {
  const pubkeys = new Set()
  const seen = new Set()

  for (const person of $people) {
    const {name, about} = person.profile
    const key = `${name}:${about}`

    if (seen.has(key)) {
      pubkeys.add(person.pubkey)
    } else {
      seen.add(key)
    }
  }

  return pubkeys
})
