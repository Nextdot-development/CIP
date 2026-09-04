/** A small hand-rolled icon set. Line icons, 1.7 stroke, calm and consistent. */
type Props = { name: IconName; size?: number; strokeWidth?: number; className?: string };

export type IconName =
  | 'home' | 'teach' | 'ask' | 'trust' | 'bell' | 'help'
  | 'chevron-down' | 'arrow-right' | 'check' | 'plus' | 'pencil'
  | 'sparkle' | 'image' | 'video' | 'doc' | 'grid'
  | 'megaphone' | 'alert' | 'bolt' | 'trend' | 'palette' | 'book' | 'voice' | 'box'
  | 'link' | 'clock' | 'shield' | 'close' | 'people' | 'lock' | 'unlock'
  | 'x' | 'signout';

const P: Record<IconName, string> = {
  home: 'M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  teach: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H19a1 1 0 0 1 1 1v12H6a2 2 0 0 0-2 2zM6 17h14v3H6a2 2 0 0 1 0-3z',
  ask: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4z',
  trust: 'M12 3l7.5 3v5.6c0 4.3-3 8.2-7.5 9.4-4.5-1.2-7.5-5.1-7.5-9.4V6z M9 12l2.2 2.2L15.5 10',
  bell: 'M18 15V10a6 6 0 1 0-12 0v5l-1.6 2.4A.4.4 0 0 0 4.8 18h14.4a.4.4 0 0 0 .4-.6z M10 21h4',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6 M12 17.2v.01',
  'chevron-down': 'M6 9.5l6 6 6-6',
  'arrow-right': 'M5 12h13 M13 7l5 5-5 5',
  check: 'M5 12.5l4.5 4.5L19 7',
  plus: 'M12 5v14 M5 12h14',
  pencil: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  image: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z M4 16l4.5-4.5a1.5 1.5 0 0 1 2.1 0L16 17 M14.5 15.5l1.6-1.6a1.5 1.5 0 0 1 2.1 0L20 15.6 M9.5 9.5v.01',
  video: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h8A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 16.5z M15 10.5l4.3-2.4a.5.5 0 0 1 .7.5v6.8a.5.5 0 0 1-.7.5L15 13.5z',
  doc: 'M6 4h7l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M13 4v5h5 M8.5 13h7 M8.5 16.5h5',
  grid: 'M4.5 4.5h6v6h-6z M13.5 4.5h6v6h-6z M4.5 13.5h6v6h-6z M13.5 13.5h6v6h-6z',
  megaphone: 'M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l7 4V6.5l-7 4H5.5A1.5 1.5 0 0 0 4 12z M18 9.5a3.5 3.5 0 0 1 0 5 M7.5 15.5l1 4.5h2.5l-1-4.5',
  alert: 'M12 4.5 21 19.5H3z M12 10v4 M12 17v.01',
  bolt: 'M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13z',
  trend: 'M4 17l5.5-5.5 3.5 3.5L20 8 M15.5 8H20v4.5',
  palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.5 0-.5-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.8.7-1.5 1.6-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8z M7.5 12v.01 M9.5 8.5v.01 M14 7.5v.01',
  book: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5z M20 5.5A1.5 1.5 0 0 0 18.5 4H12v16h6.5a1.5 1.5 0 0 0 1.5-1.5z',
  voice: 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v3',
  box: 'M12 3 4 7v10l8 4 8-4V7z M4 7l8 4 8-4 M12 11v10',
  link: 'M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2 M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5V12l3 2',
  shield: 'M12 3l7.5 3v5.6c0 4.3-3 8.2-7.5 9.4-4.5-1.2-7.5-5.1-7.5-9.4V6z',
  close: 'M6 6l12 12 M18 6 6 18',
  x: 'M6 6l12 12 M18 6 6 18',
  signout: 'M15.5 8.5V6a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.5 M10.5 12h10 M18 9l3 3-3 3',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M16 4.5a3.5 3.5 0 0 1 0 7 M17 14.2a6.5 6.5 0 0 1 4.5 5.8',
  lock: 'M7 10.5V8a5 5 0 0 1 10 0v2.5 M5.5 10.5h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
  unlock: 'M7 10.5V8a5 5 0 0 1 9.6-2 M5.5 10.5h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
};

export function Icon({ name, size = 18, strokeWidth = 1.7, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={P[name]} />
    </svg>
  );
}
