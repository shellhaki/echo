// Resolve the current web user from the signed cookie (creating one if needed).
// Only usable inside Route Handlers / Server Functions.

import { cookies } from "next/headers";
import { newAnonUser, signUser, verifyUser } from "./identity";

const COOKIE = "wb_user";

export async function getWebUser(): Promise<string> {
  const jar = await cookies();
  const existing = verifyUser(jar.get(COOKIE)?.value);
  if (existing) return existing;
  const user = newAnonUser();
  await setWebUser(user);
  return user;
}

export async function setWebUser(user: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, signUser(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}
