import { buildHeaders } from './headers'

export function test() {
  const headers = buildHeaders({}, 'example.com', 'key123', 42)
  return headers
}
