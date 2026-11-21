import c from "@shikijs/langs/c";
import regexp from "@shikijs/langs/regexp";
import type { LanguageRegistration } from "@shikijs/primitive/types";
import macro from "tm-grammars/grammars/cpp-macro.json";
import cpp from "tm-grammars/grammars/cpp.json";

// Only ship the licensed C/C++ and regexp grammars, not optional embedded shaders.
const grammars = [...c, ...regexp, macro, cpp] as LanguageRegistration[];
export default grammars;
