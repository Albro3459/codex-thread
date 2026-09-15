export function captureStream() {
  let output = ""
  return {
    stream: {
      write(chunk) {
        output += String(chunk)
        return true
      },
    },
    read: () => output,
  }
}
