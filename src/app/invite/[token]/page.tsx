import { Desktop } from "@/components/win98/Desktop";
import { Window } from "@/components/win98/Window";
import { AcceptInviteForm } from "./AcceptInviteForm";

/**
 * /invite/[token] — invite acceptance page.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <Desktop>
      <Window title="Group Invitation">
        <AcceptInviteForm token={token} />
      </Window>
    </Desktop>
  );
}
