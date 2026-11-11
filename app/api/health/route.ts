import { getConnectionState } from "@/lib/config";

export async function GET() {
  return Response.json({ ok: true, connections: getConnectionState() });
}
