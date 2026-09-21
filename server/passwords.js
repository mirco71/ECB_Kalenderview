// Kostenfaktor für bcrypt. Überall derselbe Wert, damit ein Passwort nicht je
// nach Anlageweg (Admin, Seed, Selbständerung) unterschiedlich stark gehasht ist.
const BCRYPT_ROUNDS = 12;

// Mindestlänge für Passwörter — gilt bei Anlage durch den Admin wie bei der
// Selbständerung.
const MIN_PASSWORD_LENGTH = 6;

module.exports = { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH };
