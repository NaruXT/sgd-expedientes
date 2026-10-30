// Tipos de los archivos de la interfaz importados con `with { type: 'text' }`
// (ver src/server/assets.ts): el import entrega su contenido como texto.
declare module '*.css' {
  const contenido: string;
  export default contenido;
}

declare module '*.svg' {
  const contenido: string;
  export default contenido;
}
