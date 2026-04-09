import { Desktop } from "@/components/win98/Desktop";
import { Window } from "@/components/win98/Window";
import { NewGroupForm } from "./NewGroupForm";

/**
 * /groups/new — group creation page.
 *
 * The form is a client component because it needs Privy's access token to
 * authenticate against the API.
 */
export default function NewGroupPage() {
  return (
    <Desktop>
      <Window title="New Group">
        <NewGroupForm />
      </Window>
    </Desktop>
  );
}
