export default async (request, context) => {
  // Strip /api/asana prefix and forward to Asana REST API
  const url = new URL(request.url);
  const asanaPath = url.pathname.replace("/api/asana", "");
  const asanaUrl  = "https://app.asana.com/api/1.0" + asanaPath + url.search;

  const PAT = Netlify.env.get("ASANA_PAT") || "";

  const res = await fetch(asanaUrl, {
    method:  request.method,
    headers: {
      "Authorization": "Bearer " + PAT,
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
