export const BIKES = [
  { name: 'Amber', color: '#efae5d', meters: 0 },
  { name: 'Glacier', color: '#77d8f0', meters: 250 },
  { name: 'Ember', color: '#ff7863', meters: 750 },
] as const;

export const RIDERS = [
  { name: 'Scout', coat: '#ad4c49', sleeve: '#d57661', scarf: '#efae5d', cap: '#273b55', flips: 0 },
  { name: 'Piper', coat: '#246f66', sleeve: '#55ae91', scarf: '#f5d384', cap: '#55395d', flips: 1 },
  { name: 'Nova', coat: '#514588', sleeve: '#8d76ca', scarf: '#ff9eb7', cap: '#203349', flips: 3 },
] as const;

export const MISSIONS = [
  { label: 'Ride 150 metres', metric: 'distance', target: 150 },
  { label: 'Collect 8 glowstones', metric: 'coins', target: 8 },
  { label: 'Land a backflip', metric: 'tricks', target: 1 },
] as const;
export const MISSION_BONUS = 500;

