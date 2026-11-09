export const PASSWORD_PRIVATE_MESSAGE = 'Private sign-in is open. Finish or close the password window before continuing assistant tools.';

/** App-wide because native desktop capture and commands can observe other chats.
 * Epoch checks also discard reads that began before private mode was entered. */
export class PasswordPrivacy {
  private held = false;
  private revision = 0;
  get active() { return this.held; }
  get epoch() { return this.revision; }
  enter() { if (this.held) throw Error(PASSWORD_PRIVATE_MESSAGE); this.held = true; this.revision++; }
  leave() { this.held = false; this.revision++; }
  assert(epoch = this.revision) { if (this.held || epoch !== this.revision) throw Error(PASSWORD_PRIVATE_MESSAGE); }
}
export const passwordPrivacy = new PasswordPrivacy();
