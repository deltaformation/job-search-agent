import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SECURITY_HEADERS } from "./src/security/headers";
import { defaultLocalHosts, verifyHostHeader } from "./src/security/origin";

/**
 * Edge-safe request gate. Deep-imports only (never the security barrel):
 * rejects rebinding/forged Host headers everywhere, then stamps the
 * breakage-free security headers. Per-route Origin/CSRF checks for
 * mutations live with the route handlers that own them.
 */
export function middleware(request: NextRequest): Response {
  const port = Number(process.env.PORT ?? 3000);
  if (!verifyHostHeader(request.headers.get("host"), defaultLocalHosts(port))) {
    return new Response("Forbidden", { status: 403 });
  }
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
