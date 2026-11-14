# SuperPrecio CL 🛒🇨🇱

**Comparador Inteligente de Supermercados de Chile con Variabilidad de Precios, Carritos de Compra, Costo de Fricción, Falsos Packs Ahorro e IPC Personal.**

Compara automáticamente precios por unidad canónica (`$/kg`, `$/L`, `$/100g`, `$/100ml`, `$/un`, `$/10g proteína`) en los principales supermercados chilenos:
- **Jumbo** (Cencosud)
- **Santa Isabel** (Cencosud)
- **Unimarc** (SMU)
- **Tottus** (Falabella)
- **Lider** (Walmart Chile — mediante Bookmarklet de 1 Clic / extracción del navegador)

---

## 🚀 Inicio Rápido

1. **Requisitos:** Node.js v24+ (incluye `node:sqlite` nativo sin dependencias externas) o Docker.
2. **Ejecutar localmente:**
   ```bash
   npm start
   # o bien doble clic en iniciar.bat
   ```
3. **Abrir en tu navegador:** [http://localhost:3456](http://localhost:3456)

---

## ☁️ Despliegue en la Nube (Railway / Docker)

La aplicación está preparada para ejecutarse 24/7 en la nube (manteniendo SQLite persistente, el rastreador automático de precios y las alertas de Telegram activos desde cualquier PC o celular):

- **Docker:** incluye `Dockerfile` basado en `node:24-alpine` con persistencia en `/data`.
- **Healthcheck:** `GET /health` responde inmediatamente `200 OK` (`{"ok":true,...}`) mientras el sembrado inicial corre en segundo plano.
- **Variables de entorno soportadas:**
  - `PORT` (por defecto `3456`) y `HOST` (por defecto `0.0.0.0`).
  - `DATA_DIR` o `RAILWAY_VOLUME_MOUNT_PATH`: carpeta donde se guarda `precios.db` (ej. volumen persistente montado en `/data`).
  - `ACCESS_PASSWORD`: **recomendado en la nube**; activa pantalla de bloqueo con cookie de sesión `HttpOnly` para proteger la interfaz y las rutas `/api/*`. También permite autenticación por cabecera (`x-access-key` o `Authorization: Bearer ...`) para consultas automáticas.
- **Bookmarklet en HTTPS:** al abrir la app desde tu dominio HTTPS (ej. `https://tu-app.up.railway.app`), el botón del Bookmarklet de Lider se genera automáticamente apuntando a ese origen e incluye su token firmado cuando `ACCESS_PASSWORD` está activo.

---

## ✨ Características y Módulos Implementados

### 1. Comparación por Unidad Canónica Real (`$/kg`, `$/L`, `$/10g proteína`)
- Motor inteligente que extrae volumen y peso desde nombres confusos (ej. *"pack 6 x 200 ml"*, *"envase 900 g"* vs *"1 kg"*).
- Selector de escala global:
  - **Base:** `$/kg` · `$/L` · `$/un`
  - **Por 100:** `$/100g` · `$/100ml`
  - **Pequeño:** `$/g` · `$/ml`
  - **Nutricional:** `$/10g de Proteína` pura estimada según densidad alimenticia (pollo, atún, huevos, legumbres, leche, avena, yogur griego, etc.).

### 2. Generador y Optimizador de Carritos de Compra con Fricción de Despacho
- Compara tu lista completa de compras en segundos.
- Puedes ingresar productos uno a uno o pegar una lista completa de texto (ej. *"4 x Leche entera 1L"*, *"2 x Arroz grado 1"*).
- Evalúa **3 Estrategias de Compra:**
  1. **Todo en 1 solo supermercado:** La opción más cómoda.
  2. **Combinar máximo 2 tiendas:** Excelente balance esfuerzo / ahorro.
  3. **Compra dividida óptima:** Comprar cada producto en la tienda donde es más barato.
- **Costo de Fricción (Despacho / Bencina / Tiempo):** Simula el costo por tienda extra (por defecto \$3.500) y el umbral de despacho gratis (ej. sobre \$35.000). El sistema emite un **Veredicto Inteligente**: si dividir el pedido cuesta más en despachos que el ahorro en productos, te alerta para no perder dinero.

### 3. Simulador de Tarjetas y Calendario Bancario de Descuentos
- Simula promociones según el día de la semana y tus tarjetas activas:
  - **CMR Falabella** (Tottus - martes y miércoles de carnes)
  - **Cencosud Scotiabank / Jumbo Prime** (Jumbo y Santa Isabel - lunes, jueves y fin de semana)
  - **Club Unimarc** (SMU - martes de club)
  - **Tarjeta Lider Bci** (Walmart - miércoles de 6% cashback)
  - **BancoEstado / Cuenta RUT / Tenpo** (Unimarc y Lider)

### 4. Semáforo "¿Compro Hoy o Espero?" y Detección de Ofertas Infladas
- **🟢 Piso Histórico (¡Stockeo!):** El producto está en su mínimo histórico registrado en la base de datos (o un 12%+ bajo su promedio).
- **🔴 Oferta Dudosa / Inflada:** El supermercado muestra un cartel de promoción, pero el precio vigente es igual o superior a su promedio histórico.
- **🟡 Precio Habitual:** Variación normal sin cambios bruscos.
- **🔴 Sobre el Promedio:** Más de un 8% sobre el precio habitual; conviene postergar la compra.

### 5. Detector de Reduflación (Shrinkflation) y Falsos Packs Ahorro
- **Reduflación:** Avisa si un producto mantiene su precio o sube mientras su fabricante achicó el envase (ej. de 1.000 g a 900 g, o de 1 L a 900 ml).
- **Falsos Packs Ahorro (Envases Trampa):** Detecta automáticamente cuando un envase grande o multi-pack es más caro por kilo o litro que llevar envases unitarios o pequeños de la misma marca.

### 6. IPC Personal (Inflación de tu Canasta Hogareña)
- Mide la inflación ponderada exclusivamente de los productos que tú consumes.
- Identifica qué cadena de supermercados ha subido más sus precios y cuál los ha mantenido más estables.
- Ranking de productos con mayores alzas y mayores bajas.

### 7. Alertas Push por Telegram
- Envía notificaciones a tu teléfono móvil en tiempo real cuando el programador automático detecta que un producto en seguimiento alcanza su piso histórico.

### 8. Bookmarklet de 1 Clic (Importación sin Bloqueos Antibot)
- Para `super.lider.cl` u otras tiendas protegidas por PerimeterX / Queue-it:
  - Arrastra el botón verde a la barra de marcadores de Chrome o Edge (`Ctrl + Shift + B`).
  - Navega normalmente en tu súper favorito y haz clic en el marcador: extraerá de forma segura los precios y los enviará a tu comparador local.

---

## 🛠️ Arquitectura Técnica

- **Backend:** Node.js HTTP Server nativo (sin dependencias infladas).
- **Base de Datos:** SQLite nativo vía `node:sqlite` (`data/precios.db`) con soporte WAL para lecturas y escrituras simultáneas ultrarrápidas.
- **Frontend:** Vanilla JavaScript modular, CSS custom responsive con tema oscuro, Chart.js para gráficos de evolución de precios.
- **Puertos:** `http://localhost:3456`
