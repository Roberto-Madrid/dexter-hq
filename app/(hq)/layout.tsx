import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { emailFromCookie } from "../generated/hq.js";

export const dynamic = "force-dynamic";

export default async function HqLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const header = jar.getAll().map((item) => `${item.name}=${item.value}`).join("; ");
  if (!emailFromCookie(header || null)) redirect("/login");
  return children;
}
