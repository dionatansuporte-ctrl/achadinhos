
const PREFIXOS_SUSPEITOS = ["62", "63"];

function verificarNumero(numero) {
  if (typeof numero !== "string") {
    return "REVISAR";
  }

  const digitos = numero.replace(/\D/g, "");

  if (!digitos) return "REVISAR";

  return PREFIXOS_SUSPEITOS.some(prefixo =>
    digitos.startsWith(prefixo)
  )
    ? "SUSPEITO"
    : "NAO_BLOQUEADO";
}

console.log(verificarNumero("628123456789"));
console.log(verificarNumero("639123456789"));
console.log(verificarNumero("5544999999999"));
