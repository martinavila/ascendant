import { TECHS } from './techs';
import { BUILDINGS, PROJECTS } from './buildings';
import { HULLS, PARTS } from './ships';
import { PLANET_TYPES, SPECIES, TERRAFORM_NEXT } from './world';
import type { BuildingDef, HullDef, PartDef, PlanetTypeDef, ProjectDef, SpeciesDef } from '../types';
import type { TechWithTier } from './techs';

const byId = <T extends { id: string }>(arr: T[]) => Object.fromEntries(arr.map((x) => [x.id, x])) as Record<string, T>;

export const TECH: Record<string, TechWithTier> = byId(TECHS);
export const BUILDING: Record<string, BuildingDef> = byId(BUILDINGS);
export const PROJECT: Record<string, ProjectDef> = byId(PROJECTS);
export const HULL: Record<string, HullDef> = byId(HULLS);
export const PART: Record<string, PartDef> = byId(PARTS);
export const PLANET_TYPE: Record<string, PlanetTypeDef> = byId(PLANET_TYPES);
export const SPECIES_BY_ID: Record<string, SpeciesDef> = byId(SPECIES);

export { TECHS, BUILDINGS, PROJECTS, HULLS, PARTS, PLANET_TYPES, SPECIES, TERRAFORM_NEXT };

/** Everything a tech unlocks, for tooltips and the encyclopedia. */
export function unlocksOf(techId: string) {
  return {
    buildings: BUILDINGS.filter((b) => b.tech === techId),
    parts: PARTS.filter((p) => p.tech === techId),
    hulls: HULLS.filter((h) => h.tech === techId),
    projects: PROJECTS.filter((p) => p.tech === techId),
  };
}

export const STAR_NAMES = [
  'Achernar', 'Alcyone', 'Aldhibah', 'Alnair', 'Ankaa', 'Arrakis', 'Aspidiske', 'Atria', 'Avior', 'Azha', 'Baten', 'Beid', 'Biham', 'Caph',
  'Castula', 'Celaeno', 'Chara', 'Chertan', 'Cursa', 'Dabih', 'Deneb', 'Diadem', 'Dschubba', 'Elnath', 'Eltanin', 'Enif', 'Errai', 'Fomal',
  'Furud', 'Gacrux', 'Gienah', 'Gomeisa', 'Grumium', 'Hadar', 'Hamal', 'Heze', 'Homam', 'Izar', 'Jabbah', 'Kaffa', 'Kajam', 'Kaus', 'Keid',
  'Kochab', 'Kornephoros', 'Kraz', 'Lesath', 'Libertas', 'Maasym', 'Maia', 'Marfik', 'Markab', 'Matar', 'Mebsuta', 'Megrez', 'Menkar', 'Merak',
  'Miaplacidus', 'Mintaka', 'Mirach', 'Mirzam', 'Muphrid', 'Naos', 'Nashira', 'Nekkar', 'Nihal', 'Nunki', 'Nusakan', 'Okab', 'Peacock', 'Phact',
  'Phecda', 'Pleione', 'Polaris', 'Porrima', 'Propus', 'Rasalas', 'Rastaban', 'Regor', 'Rigel', 'Rotanev', 'Ruchbah', 'Rukbat', 'Sabik', 'Sadr',
  'Saiph', 'Salm', 'Sargas', 'Scheat', 'Segin', 'Seginus', 'Sham', 'Shaula', 'Sheliak', 'Sirrah', 'Skat', 'Spica', 'Sualocin', 'Subra', 'Suhail',
  'Talitha', 'Tania', 'Tarazed', 'Tegmine', 'Tejat', 'Thuban', 'Tiaki', 'Toliman', 'Tureis', 'Unuk', 'Vega', 'Vindemiatrix', 'Wasat', 'Wazn',
  'Wezen', 'Yed', 'Yildun', 'Zaniah', 'Zaurak', 'Zavijava', 'Zosma', 'Zubenelgenubi', 'Acamar', 'Adhara', 'Albali', 'Alchiba', 'Alderamin',
  'Alfirk', 'Algenib', 'Algol', 'Alhena', 'Alioth', 'Alkaid', 'Almach', 'Alnilam', 'Alphard', 'Alrescha', 'Alshain', 'Altair', 'Aludra', 'Ancha',
];

export const NAME_SYLLABLES = ['ka', 'ro', 'vex', 'ul', 'tha', 'mir', 'zen', 'qo', 'ari', 'dus', 'sel', 'nor', 'phi', 'lox', 'tur', 'ess', 'bra', 'kyr', 'oma', 'vel', 'jin', 'dra', 'sco', 'ith'];
