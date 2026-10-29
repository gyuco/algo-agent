declare module 'picomatch' {
  /** Returns a matcher for one glob. */
  export default function picomatch(
    pattern: string,
    options?: { dot?: boolean },
  ): (input: string) => boolean;
}
