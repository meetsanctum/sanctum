// Small parts Weather's page uses in more than one section.

/**
 * A section's heading as ui-sdk's PageSection writes one, for a section
 * that is not one card: the weather now, which stands on the page itself,
 * and today's measures, each a card of its own.
 */
export function Heading(props: { id: string; children: string }) {
  return (
    <div className="flex min-h-7 items-baseline">
      <h2 id={props.id} className="m-0 text-[15px] leading-[22px] font-medium">
        {props.children}
      </h2>
    </div>
  );
}

/** A percentage in Weather's colour, such as a chance of rain; nothing below a fifth, in a slot that keeps its place. */
export function Chance(props: { percent: number | null; className: string }) {
  const isShown = props.percent !== null && props.percent >= 20;
  return (
    <span className={`font-medium text-cyan ${props.className}`}>
      {isShown && (
        <>
          {Math.round(props.percent!)}%
          <span className="sr-only"> chance of rain</span>
        </>
      )}
    </span>
  );
}
