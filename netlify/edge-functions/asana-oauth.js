const CLIENT_ID     = "1214314415420003";
const CLIENT_SECRET = "e9390b801c68b1ade9e98cd7d9084935";
const REDIRECT_URI  = "https://neon-smakager-9acd0a.netlify.app/auth/callback";

export default async (request) => {
  console.log("OAuth callback triggered:", request.url);

  const url   = new URL(request.url);
  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  console.log("Code:", code ? "present" : "missing", "Error:", error);

  if (error || !code) {
    return Response.redirect("https://neon-smakager-9acd0a.netlify.app/login.html?error=access_denied", 302);
  }

  try {
    const body = new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      code,
    });

    console.log("Exchanging code for token...");

    const tokenRes = await fetch("https://app.asana.com/-/oauth_token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    const tokenData = await tokenRes.json();
    console.log("Token response status:", tokenRes.status, "has token:", !!tokenData.access_token);

    if (!tokenData.access_token) {
      console.log("Token error:", JSON.stringify(tokenData));
      return Response.redirect("https://neon-smakager-9acd0a.netlify.app/login.html?error=token_failed", 302);
    }

    const token    = tokenData.access_token;
    const headers  = new Headers();
    headers.set("Location", "https://neon-smakager-9acd0a.netlify.app/");
    headers.set("Set-Cookie",
      `asana_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`
    );

    return new Response(null, { status: 302, headers });

  } catch (e) {
    console.log("Exception:", e.message);
    return Response.redirect("https://neon-smakager-9acd0a.netlify.app/login.html?error=server_error", 302);
  }
};
