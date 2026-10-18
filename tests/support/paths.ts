import { sep } from 'node:path'

/**
 * A file system path with `/` separators, on every platform: the form of import
 * specifiers and routes, which the tests compare paths with. On Windows Node's
 * path functions answer with `\`.
 */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}
