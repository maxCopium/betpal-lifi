import { Desktop } from "@/components/win98/Desktop";
import { Window } from "@/components/win98/Window";
import { GroupDashboard } from "./GroupDashboard";
import { LoginButton } from "@/app/LoginButton";

/**
 * /groups/[id] — group dashboard. Stub for Day 2: shows the id and renders the
 * client component which fetches the rest. Real layout (members, balance,
 * deposit button) lands later in Day 2.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Desktop>
      <Window title={`Group ${id.slice(0, 8)}`}>
        <div style={{ marginBottom: 8 }}>
          <LoginButton />
        </div>
        <GroupDashboard groupId={id} />
      </Window>
    </Desktop>
  );
}
