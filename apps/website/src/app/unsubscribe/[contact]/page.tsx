import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { productName } from "../../../../../client/src/brand";
import { isContactId } from "../../../waitlist/join";
import { Knot } from "../../knot";
import { LeaveForm } from "./leave-form";

export const metadata: Metadata = {
  title: `Leave the waitlist · ${productName}`,
  robots: { index: false },
};

// Where the Unsubscribe in a waitlist email leads: one question, and the
// button that answers it. Opening the page changes nothing, since mail
// apps open links on their own.
export default async function Page(props: {
  params: Promise<{ contact: string }>;
}) {
  const { contact } = await props.params;
  if (!isContactId(contact)) notFound();
  return (
    <div className="page">
      <header className="bar">
        <a className="logo" href="/">
          <Knot size={28} />
          <span>{productName}</span>
        </a>
      </header>
      <main className="leave">
        <LeaveForm contact={contact} />
      </main>
    </div>
  );
}
