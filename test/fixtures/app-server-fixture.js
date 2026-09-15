import { EventEmitter } from "node:events"

class FakeStream extends EventEmitter {
  emitData(chunk) {
    this.emit("data", chunk)
  }
}

class FakeStdin extends EventEmitter {
  constructor(child) {
    super()
    this.child = child
    this.destroyed = false
    this.writableEnded = false
  }

  write(value) {
    if (this.destroyed || this.writableEnded) {
      throw new Error("stdin is closed")
    }
    this.child.receive(value)
    return true
  }

  end() {
    if (this.writableEnded) return
    this.writableEnded = true
    this.child.handleStdinEnd()
  }
}

export class FakeAppServerProcess extends EventEmitter {
  constructor({
    autoSpawn = true,
    closeCode = 0,
    closeSignal = null,
    closeOnStdinEnd = true,
    chunkSize = 1,
    onRequest,
  } = {}) {
    super()
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
    this.stdin = new FakeStdin(this)
    this.requests = []
    this.closeCode = closeCode
    this.closeSignal = closeSignal
    this.closeOnStdinEnd = closeOnStdinEnd
    this.chunkSize = chunkSize
    this.onRequest = onRequest || ((request, child) => {
      if (request.method === "initialize") {
        child.send({ id: request.id, result: { fixture: true } })
      } else if (request.method === "thread/list") {
        child.send({ id: request.id, result: { data: [], nextCursor: null } })
      } else if (request.method === "thread/read") {
        child.send({
          id: request.id,
          result: { threadId: request.params.threadId, turns: [] },
        })
      }
    })
    this.killed = false
    this.closed = false

    if (autoSpawn) {
      queueMicrotask(() => this.emit("spawn"))
    }
  }

  receive(value) {
    const lines = String(value).split("\n")
    for (const line of lines) {
      if (line.trim() === "") continue
      const request = JSON.parse(line)
      this.requests.push(request)
      this.onRequest(request, this)
    }
  }

  send(message) {
    this.sendRaw(JSON.stringify(message) + "\n")
  }

  sendRaw(value) {
    for (let index = 0; index < value.length; index += this.chunkSize) {
      this.stdout.emitData(value.slice(index, index + this.chunkSize))
    }
  }

  writeStderr(value) {
    this.stderr.emitData(value)
  }

  handleStdinEnd() {
    if (!this.closeOnStdinEnd) return
    queueMicrotask(() => this.exit(this.closeCode, this.closeSignal))
  }

  kill() {
    this.killed = true
  }

  exit(code = this.closeCode, signal = this.closeSignal) {
    if (this.closed) return
    this.closed = true
    this.emit("close", code, signal)
  }
}

export function createSpawnProcess(fakeProcess) {
  const spawnProcess = (...args) => {
    spawnProcess.calls.push(args)
    return fakeProcess
  }
  spawnProcess.calls = []
  return spawnProcess
}
