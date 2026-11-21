/** Vite turns imported audio files into URLs of the bundled, hashed asset. */
declare module '*.wav' {
  const url: string;
  export default url;
}
