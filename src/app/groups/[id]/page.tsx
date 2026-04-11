import { GroupDashboard } from "./GroupDashboard";
import { LoginButton } from "@/app/LoginButton";

/**
 * /groups/[id] — group dashboard with multiple draggable windows.
 * Each section (group info, deposit, withdraw, bets, wallet) is its own window.
 */
export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <LoginButton />
      </div>
      <GroupDashboard groupId={id} />
    </>
  );
}
