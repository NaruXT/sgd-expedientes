# Certificado de prueba

`cert.pem` y `key.pem` son un certificado autofirmado y su clave, generados solo para los tests.
Valen únicamente para `localhost` y `127.0.0.1`, y no protegen ningún servidor real.
Los tests los usan para levantar un servidor HTTPS local que imita al SGD.

No los instales como certificado de confianza en ningún equipo.

Se generaron con:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 36500 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
