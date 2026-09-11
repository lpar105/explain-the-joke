export const DEV_PIPELINE_EMAIL = "devwithlex@gmail.com";

export function isAllowedDevEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() === DEV_PIPELINE_EMAIL;
}
