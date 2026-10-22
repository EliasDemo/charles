/**
 * Datos ficticios de la demostración de Juliaca (nombres, calles y personas inventados; las zonas
 * y coordenadas aproximadas sí son de Juliaca, Puno).
 */

export type PlanCode = 'gratis' | 'pro' | 'premium' | 'independiente_gratis' | 'independiente';

export interface DemoShop {
  key: string;
  name: string;
  description: string;
  address: string;
  latitude: number;
  longitude: number;
  type: 'BARBERSHOP' | 'INDEPENDENT';
  plan: PlanCode;
  /** Estado de la suscripción de pago (si el plan no es gratis). */
  subscription?: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED';
  owner: { first: string; last: string };
  barbers: { first: string; last: string; years: number; headline: string }[];
  /** Estilos en los que se especializa (claves del catálogo). */
  styles: string[];
  photos: number;
  sunday: boolean;
}

export const DEMO_SHOPS: DemoShop[] = [
  {
    key: 'imperial',
    name: 'Barbería El Imperial',
    description:
      'Barbería clásica en el corazón de Juliaca. Cortes de tijera, fades y afeitado con toalla caliente.',
    address: 'Jr. San Román 345, Cercado, Juliaca',
    latitude: -15.4994,
    longitude: -70.1331,
    type: 'BARBERSHOP',
    plan: 'premium',
    subscription: 'ACTIVE',
    owner: { first: 'Rolando', last: 'Quispe Mamani' },
    barbers: [
      {
        first: 'Rolando',
        last: 'Quispe Mamani',
        years: 15,
        headline: 'Maestro barbero, especialista en tijera',
      },
      { first: 'Jhon', last: 'Apaza Condori', years: 6, headline: 'Fades y diseños' },
      { first: 'Brayan', last: 'Huanca Ticona', years: 4, headline: 'Pompadour y quiff' },
      { first: 'Edwin', last: 'Calsin Pari', years: 8, headline: 'Barba y afeitado clásico' },
    ],
    styles: ['classic_scissors', 'pompadour', 'fade_mid', 'side_part', 'slick_back'],
    photos: 20,
    sunday: true,
  },
  {
    key: 'fadehouse',
    name: 'Fade House Juliaca',
    description:
      'Especialistas en degradados y diseños. Ambiente urbano, buena música y reservas al toque.',
    address: 'Av. Independencia 1450, Juliaca',
    latitude: -15.505,
    longitude: -70.138,
    type: 'BARBERSHOP',
    plan: 'premium',
    subscription: 'ACTIVE',
    owner: { first: 'Kevin', last: 'Mamani Larico' },
    barbers: [
      { first: 'Kevin', last: 'Mamani Larico', years: 9, headline: 'Rey del fade en Juliaca' },
      { first: 'Alex', last: 'Choque Yucra', years: 5, headline: 'Diseños y rayas a mano alzada' },
      { first: 'Ronald', last: 'Pacori Cutipa', years: 3, headline: 'Mohicano y spiky' },
    ],
    styles: ['fade_mid', 'hair_design', 'mohawk', 'spiky', 'buzz_cut'],
    photos: 20,
    sunday: true,
  },
  {
    key: 'santabarbara',
    name: 'Barber Club Santa Bárbara',
    description:
      'Tu club de barbería en Santa Bárbara: cortes modernos, cerveza artesanal y buena conversa.',
    address: 'Av. Circunvalación Norte 1210, Santa Bárbara, Juliaca',
    latitude: -15.489,
    longitude: -70.1415,
    type: 'BARBERSHOP',
    plan: 'pro',
    subscription: 'ACTIVE',
    owner: { first: 'Wilber', last: 'Ccama Flores' },
    barbers: [
      { first: 'Wilber', last: 'Ccama Flores', years: 11, headline: 'Undercut y taper' },
      { first: 'Daniel', last: 'Mendoza Arapa', years: 4, headline: 'Crop francés y texturizado' },
      { first: 'Luis', last: 'Sucasaire Coaquira', years: 2, headline: 'Cortes juveniles' },
    ],
    styles: ['undercut', 'taper', 'crop', 'two_block'],
    photos: 15,
    sunday: false,
  },
  {
    key: 'navaja',
    name: 'La Navaja Juliaqueña',
    description: 'Tradición juliaqueña con navaja: perfilados, afeitado y cortes clásicos.',
    address: 'Jr. 2 de Mayo 560, Juliaca',
    latitude: -15.4962,
    longitude: -70.129,
    type: 'BARBERSHOP',
    plan: 'pro',
    subscription: 'TRIALING',
    owner: { first: 'Fredy', last: 'Ramos Tito' },
    barbers: [
      { first: 'Fredy', last: 'Ramos Tito', years: 20, headline: 'Navaja y afeitado tradicional' },
      { first: 'Marco', last: 'Velasquez Puma', years: 7, headline: 'César y cortes cortos' },
    ],
    styles: ['caesar', 'classic_scissors', 'buzz_cut'],
    photos: 12,
    sunday: false,
  },
  {
    key: 'losincas',
    name: 'Barbería Los Incas',
    description: 'Cortes para toda la familia a precio justo, cerca de la plaza.',
    address: 'Av. Tacna 1020, Juliaca',
    latitude: -15.487,
    longitude: -70.135,
    type: 'BARBERSHOP',
    plan: 'pro',
    subscription: 'CANCELED',
    owner: { first: 'Hugo', last: 'Machaca Luque' },
    barbers: [
      { first: 'Hugo', last: 'Machaca Luque', years: 12, headline: 'Cortes clásicos y de niños' },
      { first: 'Elvis', last: 'Nina Huaman', years: 3, headline: 'Taper y degradado a capas' },
    ],
    styles: ['taper', 'layered', 'fringe'],
    photos: 10,
    sunday: true,
  },
  {
    key: 'donlucho',
    name: 'Barbería Don Lucho',
    description: 'La de siempre en Bellavista: rápida, económica y con buen trato.',
    address: 'Jr. Moquegua 230, Bellavista, Juliaca',
    latitude: -15.493,
    longitude: -70.126,
    type: 'BARBERSHOP',
    plan: 'pro',
    subscription: 'PAST_DUE',
    owner: { first: 'Luis', last: 'Ccori Vilca' },
    barbers: [
      { first: 'Luis', last: 'Ccori Vilca', years: 25, headline: 'Don Lucho, 25 años cortando' },
      { first: 'Percy', last: 'Ticona Gomez', years: 2, headline: 'Cortes modernos' },
    ],
    styles: ['classic_scissors', 'bowl_cut', 'mullet'],
    photos: 8,
    sunday: false,
  },
  {
    key: 'andino',
    name: 'Estilo Andino Barber',
    description: 'Barbería de barrio en La Capilla, cortes modernos con identidad andina.',
    address: 'Av. Huancané 890, La Capilla, Juliaca',
    latitude: -15.482,
    longitude: -70.1225,
    type: 'BARBERSHOP',
    plan: 'gratis',
    owner: { first: 'Nilo', last: 'Huaricallo Paye' },
    barbers: [
      { first: 'Nilo', last: 'Huaricallo Paye', years: 6, headline: 'Cabello largo y mullet' },
      { first: 'Josue', last: 'Limachi Ari', years: 1, headline: 'Aprendiz con mucho estilo' },
    ],
    styles: ['long_hair', 'mullet', 'fringe'],
    photos: 8,
    sunday: false,
  },
  {
    key: 'mercedes',
    name: 'Corte Fino Las Mercedes',
    description: 'Cortes finos y rápidos en Las Mercedes. Atendemos sin cita y con cita.',
    address: 'Av. Mártires 4 de Noviembre 780, Las Mercedes, Juliaca',
    latitude: -15.51,
    longitude: -70.13,
    type: 'BARBERSHOP',
    plan: 'gratis',
    owner: { first: 'Abel', last: 'Turpo Chambi' },
    barbers: [
      { first: 'Abel', last: 'Turpo Chambi', years: 10, headline: 'Comb over y cortes de oficina' },
    ],
    styles: ['side_part', 'classic_scissors'],
    photos: 4,
    sunday: false,
  },
  {
    key: 'yeison',
    name: 'Yeison Fade Studio',
    description: 'Barbero independiente: fades limpios y diseños en Juliaca, con cita.',
    address: 'Jr. Ramón Castilla 410, Juliaca',
    latitude: -15.501,
    longitude: -70.127,
    type: 'INDEPENDENT',
    plan: 'independiente',
    subscription: 'ACTIVE',
    owner: { first: 'Yeison', last: 'Larico Apaza' },
    barbers: [
      {
        first: 'Yeison',
        last: 'Larico Apaza',
        years: 5,
        headline: 'Barbero independiente, fades y diseños',
      },
    ],
    styles: ['fade_mid', 'hair_design', 'spiky'],
    photos: 6,
    sunday: true,
  },
  {
    key: 'renzo',
    name: 'Renzo Barber',
    description: 'Barbero independiente en San Román. Atiendo con cita.',
    address: 'Jr. Lambayeque 155, Juliaca',
    latitude: -15.4975,
    longitude: -70.1365,
    type: 'INDEPENDENT',
    plan: 'independiente_gratis',
    owner: { first: 'Renzo', last: 'Coila Quispe' },
    barbers: [{ first: 'Renzo', last: 'Coila Quispe', years: 3, headline: 'Undercut y crop' }],
    styles: ['undercut', 'crop'],
    photos: 2,
    sunday: false,
  },
];

export const DEMO_CLIENTS: { first: string; last: string }[] = [
  { first: 'Diego', last: 'Quispe Ramos' },
  { first: 'Carlos', last: 'Mamani Flores' },
  { first: 'Jose', last: 'Condori Huanca' },
  { first: 'Miguel', last: 'Apaza Ccama' },
  { first: 'Juan', last: 'Pari Calsin' },
  { first: 'Luis', last: 'Yucra Choque' },
  { first: 'Alexander', last: 'Cutipa Pacori' },
  { first: 'Jhonatan', last: 'Coaquira Sucasaire' },
  { first: 'Ruben', last: 'Arapa Mendoza' },
  { first: 'Franco', last: 'Puma Velasquez' },
  { first: 'Cristian', last: 'Luque Machaca' },
  { first: 'Edson', last: 'Huaman Nina' },
  { first: 'Gabriel', last: 'Vilca Ccori' },
  { first: 'Henry', last: 'Gomez Ticona' },
  { first: 'Ivan', last: 'Paye Huaricallo' },
  { first: 'Jorge', last: 'Ari Limachi' },
  { first: 'Kenyi', last: 'Chambi Turpo' },
  { first: 'Leonel', last: 'Apaza Larico' },
  { first: 'Mauricio', last: 'Quispe Coila' },
  { first: 'Nestor', last: 'Tito Ramos' },
  { first: 'Oscar', last: 'Condori Mamani' },
  { first: 'Pablo', last: 'Flores Quispe' },
  { first: 'Ricardo', last: 'Huanca Apaza' },
  { first: 'Sergio', last: 'Ccama Pari' },
];

export const WALK_INS: string[] = [
  'Don Agustín',
  'Teodoro',
  'Señor Félix',
  'Rodrigo (vecino)',
  'Hernán',
];

export const REVIEW_TEXTS: { rating: number; text: string | null }[] = [
  { rating: 5, text: 'Excelente corte, muy detallista. Vuelvo seguro.' },
  { rating: 5, text: 'El mejor fade que me han hecho en Juliaca.' },
  { rating: 5, text: 'Puntuales y buena atención. Recomendado.' },
  { rating: 4, text: 'Buen corte, solo tuve que esperar unos minutos.' },
  { rating: 5, text: null },
  { rating: 4, text: 'Muy bien, el local es cómodo.' },
  { rating: 5, text: 'Me explicó qué corte iba con mi cara. Quedé feliz.' },
  { rating: 3, text: 'Correcto, pero esperaba un poco más de detalle en la nuca.' },
  { rating: 5, text: 'Atención de primera y precio justo.' },
  { rating: 4, text: null },
];

/** Estilos nuevos del documento que no estaban en el catálogo (datos de cara, pelo y mantenimiento). */
export const NEW_STYLES: {
  key: string;
  name: string;
  description: string;
  faces: string[];
  hair: ('STRAIGHT' | 'WAVY' | 'CURLY' | 'COILY')[];
  maintenance: 'LOW' | 'MEDIUM' | 'HIGH';
  vibe: 'CLASSIC' | 'MODERN';
}[] = [
  {
    key: 'long_hair',
    name: 'Cabello largo',
    description: 'Melena con cuerpo, peinada hacia atrás o suelta.',
    faces: ['OVAL', 'OBLONG'],
    hair: ['WAVY', 'CURLY'],
    maintenance: 'LOW',
    vibe: 'MODERN',
  },
  {
    key: 'layered',
    name: 'Degradado a capas',
    description: 'Capas que dan movimiento y volumen.',
    faces: ['OVAL', 'ROUND'],
    hair: ['STRAIGHT', 'WAVY', 'CURLY'],
    maintenance: 'LOW',
    vibe: 'MODERN',
  },
  {
    key: 'bowl_cut',
    name: 'Seta',
    description: 'Flequillo recto y largo parejo alrededor.',
    faces: ['OVAL', 'OBLONG'],
    hair: ['STRAIGHT'],
    maintenance: 'LOW',
    vibe: 'MODERN',
  },
  {
    key: 'fringe',
    name: 'Con flequillo',
    description: 'Flequillo texturizado hacia adelante.',
    faces: ['OBLONG', 'OVAL'],
    hair: ['STRAIGHT', 'WAVY'],
    maintenance: 'MEDIUM',
    vibe: 'MODERN',
  },
  {
    key: 'mohawk',
    name: 'Mohicano',
    description: 'Franja central larga con costados muy cortos.',
    faces: ['OVAL', 'SQUARE'],
    hair: ['STRAIGHT', 'WAVY'],
    maintenance: 'HIGH',
    vibe: 'MODERN',
  },
  {
    key: 'spiky',
    name: 'Spiky',
    description: 'Puntas levantadas con producto.',
    faces: ['OVAL', 'ROUND'],
    hair: ['STRAIGHT'],
    maintenance: 'MEDIUM',
    vibe: 'MODERN',
  },
  {
    key: 'caesar',
    name: 'César',
    description: 'Corto parejo con flequillo corto y recto.',
    faces: ['OVAL', 'ROUND'],
    hair: ['STRAIGHT'],
    maintenance: 'HIGH',
    vibe: 'CLASSIC',
  },
  {
    key: 'two_block',
    name: 'Two block (coreano)',
    description: 'Costados cortos sin degradar y parte superior larga.',
    faces: ['OVAL', 'OBLONG'],
    hair: ['STRAIGHT'],
    maintenance: 'MEDIUM',
    vibe: 'MODERN',
  },
];

/** Forma de cara de la persona de la foto, según el estilo (para la búsqueda de caras parecidas). */
export const STYLE_FACES: Record<string, string[]> = {
  classic_scissors: ['OVAL', 'SQUARE', 'OBLONG'],
  long_hair: ['OVAL', 'OBLONG'],
  buzz_cut: ['OVAL', 'SQUARE'],
  pompadour: ['SQUARE', 'OVAL'],
  undercut: ['OVAL', 'SQUARE', 'OBLONG'],
  fade_mid: ['ROUND', 'SQUARE'],
  taper: ['OVAL', 'OBLONG'],
  layered: ['OVAL', 'ROUND'],
  side_part: ['OVAL'],
  bowl_cut: ['OVAL', 'OBLONG'],
  fringe: ['OBLONG', 'OVAL'],
  mohawk: ['OVAL', 'SQUARE'],
  hair_design: ['ROUND', 'OVAL', 'SQUARE'],
  spiky: ['OVAL', 'ROUND'],
  caesar: ['OVAL', 'ROUND'],
  mullet: ['OVAL', 'OBLONG'],
  crop: ['ROUND', 'OVAL', 'SQUARE'],
};

/** Proporciones típicas de cada forma (largo, frente y mandíbula sobre pómulos). */
export const FACE_RATIOS: Record<string, [number, number, number]> = {
  OVAL: [1.4, 0.92, 0.8],
  ROUND: [1.08, 0.92, 0.86],
  SQUARE: [1.12, 0.97, 0.96],
  OBLONG: [1.62, 0.95, 0.9],
  HEART: [1.32, 1.02, 0.7],
  DIAMOND: [1.35, 0.8, 0.74],
};
