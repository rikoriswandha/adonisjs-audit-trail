export default class LogBuilder {
  on() {
    return this
  }

  by() {
    return this
  }

  withMeta() {
    return this
  }

  withOld() {
    return this
  }

  withNew() {
    return this
  }

  tag() {
    return this
  }

  async commit() {
    throw new Error('LogBuilder.commit: not implemented')
  }

  async commitSync() {
    throw new Error('LogBuilder.commitSync: not implemented')
  }
}
