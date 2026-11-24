// The devices of a development home: about the number a real home has, so
// what the client draws and what changes in it can be timed as it would be
// there. Lights and plugs do what they're told; contact and motion sensors
// change by the clock, each at its own pace; climate sensors drift through
// the day. The seed (deploy/dev/seed.mjs) puts each in its room.

const minute = 60_000;

// Key, driver name and room.
export const lightNames = [
  ["floor", "Floor lamp", "Living room"],
  ["shelf", "Shelf light", "Living room"],
  ["living-ceiling", "Ceiling light", "Living room"],
  ["reading", "Reading lamp", "Living room"],
  ["strip", "Light strip", "Living room"],
  ["kitchen-ceiling", "Kitchen ceiling", "Kitchen"],
  ["counter", "Counter lights", "Kitchen"],
  ["island", "Island pendant", "Kitchen"],
  ["dining-pendant", "Dining pendant", "Dining room"],
  ["sideboard", "Sideboard lamp", "Dining room"],
  ["hallway-ceiling", "Hallway ceiling", "Hallway"],
  ["entrance", "Entrance light", "Hallway"],
  ["desk", "Desk lamp", "Office"],
  ["office-ceiling", "Office ceiling", "Office"],
  ["monitor", "Monitor light", "Office"],
  ["bedside", "Bedside lamp", "Bedroom"],
  ["bedroom-ceiling", "Bedroom ceiling", "Bedroom"],
  ["wardrobe", "Wardrobe light", "Bedroom"],
  ["kids-ceiling", "Kids' ceiling", "Kids' room"],
  ["night", "Night light", "Kids' room"],
  ["mirror", "Mirror light", "Bathroom"],
  ["bathroom-ceiling", "Bathroom ceiling", "Bathroom"],
  ["garden", "Garden lights", "Garden"],
  ["terrace", "Terrace lights", "Garden"],
];

// Key, driver name and room.
export const plugNames = [
  ["tv-plug", "TV plug", "Living room"],
  ["coffee", "Coffee machine", "Kitchen"],
  ["dishwasher", "Dishwasher", "Kitchen"],
  ["printer", "Printer", "Office"],
  ["fan", "Bedroom fan", "Bedroom"],
  ["projector", "Star projector", "Kids' room"],
  ["pump", "Fountain pump", "Garden"],
];

// A door that opens for half a minute every few minutes, and a window that
// stays open for ten minutes of every half hour, so a home shows both a
// sensor that has just opened and one open for a while; the others in
// between, each with its own pace, so they don't change together.
export const contactSensors = [
  ["balcony-door", "Balcony door", "Living room", 3 * minute, 30_000],
  ["bedroom-window", "Bedroom window", "Bedroom", 30 * minute, 10 * minute],
  [
    "living-window",
    "Living room window",
    "Living room",
    23 * minute,
    4 * minute,
  ],
  ["kitchen-window", "Kitchen window", "Kitchen", 17 * minute, 3 * minute],
  [
    "dining-window",
    "Dining room window",
    "Dining room",
    41 * minute,
    6 * minute,
  ],
  ["front-door", "Front door", "Hallway", 7 * minute, 20_000],
  ["office-window", "Office window", "Office", 37 * minute, 9 * minute],
  ["kids-window", "Kids' room window", "Kids' room", 53 * minute, 5 * minute],
  ["bathroom-window", "Bathroom window", "Bathroom", 13 * minute, 2 * minute],
  ["garden-gate", "Garden gate", "Garden", 11 * minute, 45_000],
].map(([key, name, room, every, openFor]) => ({
  key,
  name,
  room,
  every,
  openFor,
}));

// A motion sensor sees someone for a while every few minutes, each room at
// its own pace and offset, as people move through a home.
export const motionSensors = [
  ["living-motion", "Living room motion", "Living room", 4 * minute, 90_000],
  ["kitchen-motion", "Kitchen motion", "Kitchen", 3 * minute, 60_000],
  ["dining-motion", "Dining room motion", "Dining room", 9 * minute, 120_000],
  ["hallway-motion", "Hallway motion", "Hallway", 2 * minute, 20_000],
  ["office-motion", "Office motion", "Office", 5 * minute, 3 * minute],
  ["bedroom-motion", "Bedroom motion", "Bedroom", 11 * minute, 40_000],
  ["kids-motion", "Kids' room motion", "Kids' room", 7 * minute, 50_000],
  ["bathroom-motion", "Bathroom motion", "Bathroom", 6 * minute, 70_000],
  ["garden-motion", "Garden motion", "Garden", 13 * minute, 30_000],
].map(([key, name, room, every, seenFor], index) => ({
  key,
  name,
  room,
  every,
  seenFor,
  // Spread over the first minutes, so the sensors don't change together.
  offset: index * 37_000,
}));

// A climate sensor's temperature and humidity drift over the day, each
// room a little apart, so a reading changes every half minute or so.
export const climateSensors = [
  ["living-climate", "Living room climate", "Living room", 21.5, 45],
  ["kitchen-climate", "Kitchen climate", "Kitchen", 22.5, 52],
  ["dining-climate", "Dining room climate", "Dining room", 21, 46],
  ["hallway-climate", "Hallway climate", "Hallway", 19.5, 44],
  ["office-climate", "Office climate", "Office", 22, 41],
  ["bedroom-climate", "Bedroom climate", "Bedroom", 18.5, 50],
  ["kids-climate", "Kids' room climate", "Kids' room", 20.5, 48],
  ["bathroom-climate", "Bathroom climate", "Bathroom", 23, 63],
].map(([key, name, room, temperature, humidity], index) => ({
  key,
  name,
  room,
  temperature,
  humidity,
  phase: index * 0.7,
}));

export const playerNames = [
  ["tv-box", "Living room box", "Living room"],
  ["office-speaker", "Office speaker", "Office"],
];

const inRooms = Object.groupBy(
  [
    ...lightNames.map(([, name, room]) => ({ name, room })),
    ...plugNames.map(([, name, room]) => ({ name, room })),
    ...contactSensors,
    ...motionSensors,
    ...climateSensors,
    ...playerNames.map(([, name, room]) => ({ name, room })),
  ],
  ({ room }) => room,
);
export const seedRooms = Object.fromEntries(
  Object.entries(inRooms).map(([room, devices]) => [
    room,
    devices.map(({ name }) => name),
  ]),
);

// Whether a contact is open now, by the clock: open at the start of each of
// its periods.
export const isOpen = ({ every, openFor }, now = Date.now()) =>
  now % every < openFor;

// Whether a motion sensor sees someone now, by the clock.
export const seesMotion = ({ every, seenFor, offset }, now = Date.now()) =>
  (now + offset) % every < seenFor;

// A climate sensor's readings now, to a tenth of a degree and a whole
// percent: a slow swing over the day and a small one every few minutes.
export function climateOf({ temperature, humidity, phase }, now = Date.now()) {
  const day = (now / (24 * 60 * minute)) * 2 * Math.PI;
  const minutes = (now / (7 * minute)) * 2 * Math.PI;
  const swing = Math.sin(day + phase) * 1.5 + Math.sin(minutes + phase) * 0.3;
  return {
    temperature: Math.round((temperature + swing) * 10) / 10,
    humidity: Math.round(humidity - swing * 3),
  };
}
