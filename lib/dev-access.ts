export const DEV_PIPELINE_EMAIL = "devwithlex@gmail.com";
const SET_DEV_EMAIL = "laurenparkernz@gmail.com";

export function isAllowedDevEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() === DEV_PIPELINE_EMAIL;
}

export function isAllowedSetDevEmail(email: string | null | undefined, verified: boolean | undefined) {
  return verified === true && email?.trim().toLowerCase() === SET_DEV_EMAIL;
}
