import css from "@shikijs/langs/css";
import graphql from "@shikijs/langs/graphql";
import haml from "@shikijs/langs/haml";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import lua from "@shikijs/langs/lua";
import shell from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import type { LanguageRegistration } from "@shikijs/primitive/types";
import ruby from "tm-grammars/grammars/ruby.json";
import cpp from "./syntax-cpp";

// Keep Ruby's embedded languages without reintroducing GLSL through upstream C++.
const grammars = [
  ...html,
  ...haml,
  ...xml,
  ...sql,
  ...graphql,
  ...css,
  ...cpp,
  ...javascript,
  ...shell,
  ...lua,
  ...yaml,
  ruby,
] as LanguageRegistration[];
export default grammars;
