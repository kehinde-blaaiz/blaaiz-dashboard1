// Handles the OAuth callback from Asana
// Exchanges the temporary code for a real access token
// Stores token in a secure cookie, then redirects to dashboard

const CLIENT_ID     = "1214314415420003";
const CLIENT_SECRET = "e9390b801c68b1ade9e98cd7d9084935";
const REDIRECT_URI  = "https://neon-smakager-9acd0a.netlify.app/auth/callback";

export default async (request) => {
  const url  = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // User denied access
  if (error || !code) {
    return Response.redirect("https://neon-smakager-9acd0a.netlify.app/login.html?error=access_denied", 302);
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://app.asana.com/-/oauth_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return Response.redirect("https://neon-smakager-9acd0a.netlify.app/login.html?error=token_failed", 302);
    }

    const token = tokenData.access_token;

    // Store token in a secure HttpOnly cookie (expires in 1 hour)
    const response = Response.redirect("https://neon-smakager-9acd0a.netlify.app/", 302);
    response.headers.set(
      "Set-Cookie",
      `asana_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`
    );
    return response;

  } catch (e) {
    return Response.redirect("https://neon-smakager-9acd0a.netlify.app/login.html?error=server_error", 302);
  }
};
