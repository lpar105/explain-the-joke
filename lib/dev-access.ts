const SET_DEV_EMAIL = "laurenparkernz@gmail.com";

export function isAllowedSetDevEmail(email: string | null | undefined, verified: boolean | undefined) {
  return verified === true && email?.trim().toLowerCase() === SET_DEV_EMAIL;
}
