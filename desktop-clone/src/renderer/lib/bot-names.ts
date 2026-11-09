export const botNames = [
  'Pip', 'Pixel', 'Pebble', 'Nova', 'Orbit', 'Tinker', 'Widget', 'Mochi', 'Boba', 'Sprout',
  'Biscuit', 'Bean', 'Button', 'Clover', 'Comet', 'Cosmo', 'Doodle', 'Echo', 'Fizz', 'Gizmo',
  'Glow', 'Jelly', 'Kiwi', 'Luna', 'Milo', 'Miso', 'Nori', 'Noodle', 'Peanut', 'Pico',
  'Poppy', 'Pudding', 'Quill', 'Ripple', 'Scout', 'Skip', 'Spark', 'Sunny', 'Tango', 'Tofu',
  'Waffle', 'Wisp', 'Ziggy', 'Zip', 'Acorn', 'Atlas', 'Basil', 'Bento', 'Blink', 'Bloom',
  'Bramble', 'Bubble', 'Chai', 'Chipper', 'Coco', 'Dot', 'Ember', 'Fern', 'Finch', 'Flint',
  'Frodo', 'Fuzzy', 'Hatch', 'Hiccup', 'Indigo', 'Juno', 'Kiki', 'Lemon', 'Maple', 'Mint',
  'Nimbus', 'Nutmeg', 'Olive', 'Opal', 'Otto', 'Patch', 'Peach', 'Pepper', 'Pogo', 'Puck',
  'Roo', 'Rosie', 'Sage', 'Sesame', 'Socks', 'Solo', 'Squiggle', 'Starling', 'Stitch', 'Tater',
  'Thimble', 'Toast', 'Truffle', 'Tulip', 'Twinkle', 'Whim', 'Willow', 'Wren', 'Yuzu', 'Zest',
] as const;

export function randomBotName(currentName: string): string {
  const candidates = botNames.filter(name => name.toLowerCase() !== currentName.toLowerCase());
  return candidates[Math.floor(Math.random() * candidates.length)];
}
