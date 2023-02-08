import {is, prop, without} from 'ramda'
import {writable} from 'svelte/store'
import {switcherFn, ensurePlural, first} from 'hurdak/lib/hurdak'
import {defer, asyncIterableToArray} from 'src/util/misc'

// Types

type Message = {
  topic: string
  payload: object
}

type Table = {
  name: string
  subscribe: (subscription: (value: any) => void) => (() => void)
  bulkPut: (data: object) => void
  all: (where: object) => Promise<any>
  get: (key: string) => any
}

// Plumbing

const worker = new Worker('/src/workers/database.js', {type: 'module'})

worker.addEventListener('error', e => console.error(e))

class Channel {
  id: string
  onMessage: (e: MessageEvent) => void
  constructor({onMessage}) {
    this.id = Math.random().toString().slice(2)
    this.onMessage = e => onMessage(e.data as Message)

    worker.addEventListener('message', this.onMessage)
  }
  close() {
    worker.removeEventListener('message', this.onMessage)
  }
  send(topic, payload) {
    worker.postMessage({channel: this.id, topic, payload})
  }
}

const call = (topic, payload): Promise<Message> => {
  return new Promise(resolve => {
    const channel = new Channel({
      onMessage: message => {
        resolve(message)
        channel.close()
      },
    })

    channel.send(topic, payload)
  })
}

const callLocalforage = async (storeName, method, ...args) => {
  const message = await call('localforage.call', {storeName, method, args})

  if (message.topic !== 'localforage.return') {
    throw new Error(`callLocalforage received invalid response: ${message}`)
  }

  return message.payload
}


// Methods that proxy localforage

const getItem = (storeName, ...args) => callLocalforage(storeName, 'getItem', ...args)
const setItem = (storeName, ...args) => callLocalforage(storeName, 'setItem', ...args)
const removeItem = (storeName, ...args) => callLocalforage(storeName, 'removeItem', ...args)
const length = (storeName) => callLocalforage(storeName, 'length')
const clear = (storeName) => callLocalforage(storeName, 'clear')
const keys = (storeName) => callLocalforage(storeName, 'keys')

const iterate = (storeName, where = {}) => ({
  [Symbol.asyncIterator]() {
    let done = false
    let promise = defer()
    const messages = []
    const channel = new Channel({
      onMessage: m => switcherFn(m.topic, {
        'localforage.item': () => {
          promise.resolve()
          messages.push(m.payload)
        },
        'localforage.iterationComplete': () => {
          done = true
          promise.resolve()
          channel.close()
        },
      }),
    })

    channel.send('localforage.iterate', {storeName, where})

    const next = async () => {
      if (done) {
        return {done}
      }

      const [value] = messages.splice(0, 1)

      if (value) {
        return {done, value}
      } else {
        promise = defer()

        await promise

        return next()
      }
    }

    return {next}
  }
})

// Local copy of data so we can provide a sync observable interface. The worker
// is just for storing data and processing expensive queries

const registry = {}

const defineTable = (name: string): Table => {
  let p = Promise.resolve()
  let listeners = []
  let data = {}

  const subscribe = f => {
    listeners.push(f)

    f(data)

    return () => {
      listeners = without([f], listeners)
    }
  }

  const setAndNotify = newData => {
    // Update our local copy
    data = newData

    // Notify subscribers
    for (const f of listeners) {
      f(data)
    }
  }

  const bulkPut = newData => {
    setAndNotify({...data, ...newData})

    // Sync to storage, keeping updates in order
    p = p.then(() => {
      const updates = []
      for (const [k, v] of Object.entries(newData)) {
        updates.push(setItem(name, k, v))
      }

      return Promise.all(updates)
    }) as Promise<void>
  }

  const all = (where = {}) => asyncIterableToArray(iterate(name, where), prop('v'))
  const one = (where = {}) => first(all(where))
  const get = k => data[k]

  // Sync from storage initially
  ;(async () => {
    const initialData = {}
    for await (const {k, v} of iterate(name)) {
      initialData[k] = v
    }

    setAndNotify(initialData)
  })()

  registry[name] = {name, subscribe, bulkPut, all, one, get}

  return registry[name]
}

const people = defineTable('people')

// Helper to allow us to listen to changes of any given table

const listener = (() => {
  let listeners = []

  for (const table of Object.values(registry) as Array<Table>) {
    table.subscribe(() => listeners.forEach(f => f(table.name)))
  }

  return {
    subscribe: f => {
      listeners.push(f)

      return () => {
        listeners = without([f], listeners)
      }
    },
  }
})()

// Helper to re-run a query every time a given table changes

const watch = (names, f) => {
  names = ensurePlural(names)

  const store = writable(null)
  const tables = names.map(name => registry[name])

  // Initialize synchronously if possible
  const initialValue = f(...tables)
  if (is(Promise, initialValue)) {
    initialValue.then(v => store.set(v))
  } else {
    store.set(initialValue)
  }

  // Listen for changes
  listener.subscribe(async name => {
    if (names.includes(name)) {
      store.set(await f(...tables))
    }
  })

  return store
}

// Other utilities

const getPersonWithFallback = pubkey => people.get(pubkey) || {pubkey}

export default {
  getItem, setItem, removeItem, length, clear, keys, iterate,
  watch, getPersonWithFallback, people,
}
