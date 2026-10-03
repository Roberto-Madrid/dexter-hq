export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return (
    <main className="login">
      <form action="/api/login" method="post">
        <h1>Dexter.</h1>
        <p>Owner login.</p>
        {params.error ? <p className="error">That email is not the owner.</p> : null}
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
