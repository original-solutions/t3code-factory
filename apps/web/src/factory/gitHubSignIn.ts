/** gh's own words when it has no login: every repo read then fails the same way, for one cause. */
export const signedOut = (message: string): boolean =>
  /gh auth login|GH_TOKEN environment variable/.test(message);

const shellWord = (text: string): string =>
  /^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** The command that signs the factory's gh in, in the config directory the factory reads. */
export const signInCommand = (ghConfigDir: string): string =>
  ghConfigDir === "" ? "gh auth login" : `GH_CONFIG_DIR=${shellWord(ghConfigDir)} gh auth login`;
