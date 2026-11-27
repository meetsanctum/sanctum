import { User, Users } from "lucide-react";

import type { FoundHost } from "../shell";
import { Sheet, SheetRow } from "./sheet";

// How this device joins a home: as someone's own, signed in with their
// username and password or joined with an invite code, or as a shared device such as a wall display,
// which nobody signs in on and another device approves. Both ways weigh the
// same here, so a wall display never opens on a password form.
export function WhoUses(props: {
  host: FoundHost;
  onBack: () => void;
  onPersonal: () => void;
  onShared: () => void;
}) {
  return (
    <Sheet
      title="Who uses this device?"
      subtitle={`This device joins ${props.host.name}.`}
      back={{ to: "Homes", onBack: props.onBack }}
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        <li>
          <SheetRow
            icon={User}
            name="Just me"
            detail="Sign in, or join with an invite code."
            onClick={props.onPersonal}
          />
        </li>
        <li>
          <SheetRow
            icon={Users}
            name="Everyone at home"
            detail="A shared device, such as a wall display or a kitchen tablet. Someone approves it from another device."
            onClick={props.onShared}
          />
        </li>
      </ul>
    </Sheet>
  );
}
