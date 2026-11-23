// The devices of a development home: about the number a real home has, so
// what the client draws and what changes in it can be timed as it would be
// there. Lights and plugs do what they're told; contact and motion sensors
// change by the clock, each at its own pace; climate sensors drift through
// the day. The seed (deploy/dev/seed.mjs) puts each in its room.

const minute = 60_000;

// key, name.
export const lightNames = [
  ["floor", "Floor lamp"],
  ["shelf", "Shelf light"],
  ["living-ceiling", "Ceiling light"],
  ["reading", "Reading lamp"],
  ["strip", "Light strip"],
  ["kitchen-ceiling", "Kitchen ceiling"],
  ["counter", "Counter lights"],
  ["island", "Island pendant"],
  ["dining-pendant", "Dining pendant"],
  ["sideboard", "Sideboard lamp"],
  ["hallway-ceiling", "Hallway ceiling"],
  ["entrance", "Entrance light"],
  ["desk", "Desk lamp"],
  ["office-ceiling", "Office ceiling"],
  ["monitor", "Monitor light"],
  ["bedside", "Bedside lamp"],
  ["bedroom-ceiling", "Bedroom ceiling"],
  ["wardrobe", "Wardrobe light"],
  ["kids-ceiling", "Kids' ceiling"],
  ["night", "Night light"],
  ["mirror", "Mirror light"],
  ["bathroom-ceiling", "Bathroom ceiling"],
  ["garden", "Garden lights"],
  ["terrace", "Terrace lights"],
];

// key, name.
export const plugNames = [
  ["tv-plug", "TV plug"],
  ["coffee", "Coffee machine"],
  ["dishwasher", "Dishwasher"],
  ["printer", "Printer"],
  ["fan", "Bedroom fan"],
  ["projector", "Star projector"],
  ["pump", "Fountain pump"],
];

// A door that opens for half a minute every few minutes, and a window that
// stays open for ten minutes of every half hour, so a home shows both a
// sensor that has just opened and one open for a while; the others in
// between, each with its own pace, so they don't change together.
export const contactSensors = [
  ["balcony-door", "Balcony door", 3 * minute, 30_000],
  ["bedroom-window", "Bedroom window", 30 * minute, 10 * minute],
  ["living-window", "Living room window", 23 * minute, 4 * minute],
  ["kitchen-window", "Kitchen window", 17 * minute, 3 * minute],
  ["dining-window", "Dining room window", 41 * minute, 6 * minute],
  ["front-door", "Front door", 7 * minute, 20_000],
  ["office-window", "Office window", 37 * minute, 9 * minute],
  ["kids-window", "Kids' room window", 53 * minute, 5 * minute],
  ["bathroom-window", "Bathroom window", 13 * minute, 2 * minute],
  ["garden-gate", "Garden gate", 11 * minute, 45_000],
].map(([key, name, every, openFor]) => ({ key, name, every, openFor }));

// A motion sensor sees someone for a while every few minutes, each room at
// its own pace and offset, as people move through a home.
export const motionSensors = [
  ["living-motion", "Living room motion", 4 * minute, 90_000],
  ["kitchen-motion", "Kitchen motion", 3 * minute, 60_000],
  ["dining-motion", "Dining room motion", 9 * minute, 120_000],
  ["hallway-motion", "Hallway motion", 2 * minute, 20_000],
  ["office-motion", "Office motion", 5 * minute, 3 * minute],
  ["bedroom-motion", "Bedroom motion", 11 * minute, 40_000],
  ["kids-motion", "Kids' room motion", 7 * minute, 50_000],
  ["bathroom-motion", "Bathroom motion", 6 * minute, 70_000],
  ["garden-motion", "Garden motion", 13 * minute, 30_000],
].map(([key, name, every, seenFor], index) => ({
  key,
  name,
  every,
  seenFor,
  // Spread over the first minutes, so the sensors don't change together.
  offset: index * 37_000,
}));

// A climate sensor's temperature and humidity drift over the day, each
// room a little apart, so a reading changes every half minute or so.
export const climateSensors = [
  ["living-climate", "Living room climate", 21.5, 45],
  ["kitchen-climate", "Kitchen climate", 22.5, 52],
  ["dining-climate", "Dining room climate", 21, 46],
  ["hallway-climate", "Hallway climate", 19.5, 44],
  ["office-climate", "Office climate", 22, 41],
  ["bedroom-climate", "Bedroom climate", 18.5, 50],
  ["kids-climate", "Kids' room climate", 20.5, 48],
  ["bathroom-climate", "Bathroom climate", 23, 63],
].map(([key, name, temperature, humidity], index) => ({
  key,
  name,
  temperature,
  humidity,
  phase: index * 0.7,
}));

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
