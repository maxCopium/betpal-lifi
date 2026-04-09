import { Desktop } from "@/components/win98/Desktop";
import { Window } from "@/components/win98/Window";
import { PrivyAppProvider } from "@/components/PrivyAppProvider";
import { LoginButton } from "./LoginButton";

export default function HomePage() {
  return (
    <PrivyAppProvider>
      <Desktop>
        <Window title="BetPal — Welcome.exe">
          <p style={{ marginTop: 0 }}>
            Bet with friends on Polymarket outcomes. Pooled stakes earn yield
            in a shared group vault until resolution. Zero house edge.
          </p>
          <fieldset>
            <legend>Sign in</legend>
            <p>
              Use your email or Google account. We&apos;ll spin up an embedded
              wallet for you.
            </p>
            <LoginButton />
          </fieldset>
        </Window>

        <Window title="How it works">
          <ol style={{ marginTop: 0 }}>
            <li>Create a group with your friends.</li>
            <li>
              Fund the group from any chain or token (LI.FI Composer routes it
              straight into a Morpho USDC vault on Base).
            </li>
            <li>Pick a Polymarket market. Place bets against each other.</li>
            <li>While the bet is open, the pool earns yield.</li>
            <li>
              When Polymarket resolves, the winner claims the pot — to any
              chain, any token.
            </li>
          </ol>
        </Window>
      </Desktop>
    </PrivyAppProvider>
  );
}
