export class KeyedSerializer {
  #tails = new Map()

  run(key, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('Serialized operation must be a function')
    }
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.#tails.set(key, current)
    return current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key)
    })
  }
}
