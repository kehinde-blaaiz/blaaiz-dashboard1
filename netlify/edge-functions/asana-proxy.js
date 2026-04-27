export default async (request, context) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      },
    });
  }

  // Get token from cookie (set after OAuth login)
  const cookies = request.headers.get("cookie") || "";
  const match   = cookies.match(/asana_token=([^;]+)/);
  const token   = match ? decodeURIComponent(match[1]) : "";

  if (!token) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Forward request to Asana REST API
  const url      = new URL(request.url);
  const asanaPath = url.pathname.replace("/api/asana", "");
  const asanaUrl  = "https://app.asana.com/api/1.0" + asanaPath + url.search;

  const res  = await fetch(asanaUrl, {
    method:  request.method,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    body: request.method !== "GET" ? await request.text() : undefined,
  });

  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
