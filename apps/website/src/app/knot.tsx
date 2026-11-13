// The logo's knot on its 14-unit grid, the same path as assets/brand's
// sanctum-mark.svg; the desktop app's artwork test checks that it is.
export function Knot(props: { size?: number }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={props.size}
      height={props.size}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M6 11A1 1 0 0 0 8 11L10 11A3 3 0 0 1 4 11L4 7L6 7ZM7 6L3 6A1 1 0 0 0 3 8L3 10A3 3 0 0 1 3 4L7 4ZM11 10L7 10L7 8L11 8A1 1 0 0 0 11 6L11 4A3 3 0 0 1 11 10ZM10 3L10 7L8 7L8 3A1 1 0 0 0 6 3L4 3A3 3 0 0 1 10 3Z"
      />
    </svg>
  );
}
