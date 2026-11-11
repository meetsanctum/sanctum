import type { PersonInfo } from "@meetsanctum/auth-protocol";
import { Button } from "@meetsanctum/ui-sdk";
import { LogOut, Settings, UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar } from "./components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

export type Account = {
  person: PersonInfo;
  onSettings: () => void;
  onSignOut: () => void;
};

// The signed-in person at the foot of the sidebar: their avatar alone, in
// the bottom left corner, named for screen readers and in its tooltip; the
// device needs no saying. Its menu opens upwards. Profile has no screen, so
// it is dimmed.
export function UserMenu(
  props: Account & {
    isInert?: boolean;
    onOpenChange?: (open: boolean) => void;
  },
) {
  const { person } = props;
  const [isOpen, setOpen] = useState(false);
  useEffect(() => {
    if (props.isInert && isOpen) {
      setOpen(false);
      props.onOpenChange?.(false);
    }
  }, [props.isInert, isOpen, props.onOpenChange]);
  return (
    <DropdownMenu
      open={isOpen && !props.isInert}
      onOpenChange={(open) => {
        setOpen(open);
        props.onOpenChange?.(open);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="avatar"
          aria-label={`${person.name}'s menu`}
          title={person.name}
          className="mt-2 self-start"
        >
          <Avatar name={person.name} colour={person.colour} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuItem disabled>
            <UserRound />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onSettings}>
            <Settings />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {/* Space, not a separator: no dividing lines. */}
        <DropdownMenuGroup className="mt-2">
          <DropdownMenuItem onSelect={props.onSignOut}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
