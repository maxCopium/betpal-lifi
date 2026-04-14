import { Desktop } from "@/components/win98/Desktop";
import { Window } from "@/components/win98/Window";
import { BetDetail } from "./BetDetail";

/**
 * /bets/[id] — bet detail page.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export default async function BetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Desktop>
      <Window title={`Bet ${id.slice(0, 8)}`}>
        <BetDetail betId={id} />
      </Window>
    </Desktop>
  );
}
