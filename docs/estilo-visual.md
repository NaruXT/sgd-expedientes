# Estilo visual

Referencia de estilo para la interfaz de SGD Expedientes.
Se tomó de la página principal del SGD (Sistema de Gestión Documental) para que la herramienta se sienta parte del sistema que los usuarios ya conocen.

No se copian logos, nombres de instituciones, nombres de personas ni imágenes de la captura original.
La app es configurable por instituto, así que la interfaz no lleva marca de ninguna institución.

Los códigos hex son estimaciones visuales: la captura no se midió con una herramienta de color.
El SGD sigue claramente Bootstrap 3, así que donde coinciden se usan sus valores canónicos.

## 1. Estética general

- **Estilo:** Bootstrap 3 institucional.
  Panel administrativo de gobierno, sobrio y funcional.
- **Filosofía:** jerarquía por bloques de color plano.
  El azul marca qué es importante y el gris marca la navegación.
- **Influencias:** Bootstrap 3 (`panel-primary`, `list-group`, `badge`, `btn-default`) y el diseño web de mediados de la década de 2010.
  Degradados suaves en las barras y casi ninguna sombra.

## 2. Paleta de colores

Diez colores en total.

| Color | Hex | Uso en el SGD |
|---|---|---|
| Azul panel | `#428BCA` | Cabecera de paneles, enlaces y subtítulos de bandejas |
| Azul título | `#2B6CB3` | Título del sistema en la cabecera |
| Azul oscuro | `#2A6496` | Dependencia en la cabecera, texto del botón de sesión |
| Texto principal | `#333333` | Títulos de bandejas en mayúsculas |
| Texto del menú | `#555555` | Opciones del menú principal |
| Insignia gris | `#999999` | Contadores redondeados |
| Borde | `#DDDDDD` | Divisores de listas y paneles |
| Menú degradado | `#FAFAFA` a `#E6E6E6` | Franja de navegación |
| Fila alterna | `#F5F5F5` | Fondo de filas alternas |
| Pie | `#EEEEEE` | Pie con equipo, versión y unidad orgánica |

Colores propios de la app, fuera de la paleta del SGD:

| Color | Hex | Uso en SGD Expedientes |
|---|---|---|
| Resaltado | `#FFF2CC` | Filas y fichas donde la ubicación A difiere de la B (mismo color que el Excel de salida) |
| Texto sobre resaltado | `#4A3B00` | Texto dentro del resaltado |
| Error | `#F2DEDE` / `#A94442` | Avisos de error (`alert-danger` de Bootstrap 3) |
| Foco | `#66AFE9` | Contorno de foco de campos y botones |

## 3. Tipografía

- **Familia:** sans-serif del sistema, al estilo de Bootstrap 3: `"Helvetica Neue", Helvetica, Arial, sans-serif`.
- **Título de la app:** grande, peso regular, en azul.
  Es el único texto grande sin negrita.
- **Títulos de bloque:** negrita y en mayúsculas, en gris oscuro.
- **Texto secundario:** regular, alrededor de 15 px, en azul enlace.
- **Menú:** mayúsculas, peso medio, con un leve espaciado entre letras.
- **Contraste:** el título liviano y grande convive con títulos de bloque pesados y chicos.

## 4. Elementos distintivos

- **Cabecera en dos zonas.**
  A la izquierda, el título de la app.
  A la derecha, la dependencia en mayúsculas sobre el nombre del usuario, y el botón "Cerrar sesión" con borde.
- **Menú en franja gris** con separadores verticales entre opciones.
- **Panel con cabecera azul sólida**, título blanco en negrita y una bajada descriptiva.
- **Lista con filas** que combinan título en mayúsculas, descripción en azul e insignia gris redondeada a la derecha.
- **Pie gris en dos columnas:** equipo y versión a la izquierda, unidad orgánica a la derecha.
- **Formas:** radios de 4 px, bordes de 1 px y casi ninguna sombra.

## 5. Concepto visual

- El azul indica "contenido de trabajo" y el gris indica "estructura de navegación".
- Las mayúsculas imitan el lenguaje de los expedientes y bandejas del propio sistema.
- Uso ideal: herramientas internas que deben sentirse parte del SGD, para que el usuario no perciba un sistema nuevo.

## 6. Aplicación en SGD Expedientes

Los valores viven como variables CSS en `src/ui/styles.css`.

- **Cabecera:** "SGD Expedientes" en azul liviano.
  Dependencia y usuario en mayúsculas, y botón "Cerrar sesión" con borde.
- **Menú:** franja gris con "UN EXPEDIENTE", "VARIOS (EXCEL)" y "CONFIGURACIÓN".
  La opción activa queda en blanco con una línea azul inferior.
- **Paneles:** cabecera azul `#428BCA` con título blanco y una bajada de una línea.
- **Ficha del expediente:** filas con etiqueta en mayúsculas, como las bandejas del SGD.
  La rama de origen distinta se muestra en el resaltado amarillo.
- **Tabla del lote:** encabezados con el degradado del menú, filas alternas y filas A≠B en el resaltado amarillo.
- **Pie:** versión de la app y unidad orgánica.
- **Sin modo oscuro**, porque el SGD no lo tiene.

## 7. Reglas para cambios futuros

- Usar las variables CSS existentes antes de agregar colores nuevos.
- No agregar logos, nombres de instituciones ni nombres de personas: la app sirve a cualquier instituto.
- Todo dato que venga del SGD se escribe con `textContent`, nunca con `innerHTML`.
- No usar scripts ni estilos inline: la política CSP del servidor los bloquea.
- Revisar cada cambio en un navegador a 1280 px y a media pantalla (alrededor de 700 px).
