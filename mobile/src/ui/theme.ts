// One palette, two schemes, no dependency.
//
// Deliberately small: the phone app's job in step 4 is to prove the wire works,
// and a design system invented ahead of the screens that need it is a thing to
// be undone later. What is here is what more than one screen already needs —
// a surface, a text colour, a dim one for metadata, a hairline, and the three
// states the connection indicator has.

import { useColorScheme } from 'react-native';

export interface Theme {
  bg: string;
  card: string;
  text: string;
  dim: string;
  line: string;
  accent: string;
  live: string;
  warn: string;
  bad: string;
}

const light: Theme = {
  bg: '#f6f5f2',
  card: '#ffffff',
  text: '#161513',
  dim: '#6f6b63',
  line: '#e3e0d9',
  accent: '#2f6f4f',
  live: '#2f8f5b',
  warn: '#a3701c',
  bad: '#9a3b32'
};

const dark: Theme = {
  bg: '#131311',
  card: '#1c1c19',
  text: '#f1efe9',
  dim: '#9a958b',
  line: '#2b2b27',
  accent: '#7fc79d',
  live: '#5fbf85',
  warn: '#d5a445',
  bad: '#e0796d'
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
