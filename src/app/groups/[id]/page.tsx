import { GroupDashboard } from "./GroupDashboard";

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
  return <GroupDashboard groupId={id} />;
}
