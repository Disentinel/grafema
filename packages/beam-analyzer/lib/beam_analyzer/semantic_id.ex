defmodule BeamAnalyzer.SemanticId do
  @moduledoc "Builds Grafema semantic IDs for BEAM nodes."

  def module_id(file, module_name) do
    "#{file}->MODULE->#{module_name}"
  end

  def function_id(file, name, arity, module_name) do
    "#{file}->FUNCTION->#{name}/#{arity}[in:#{module_name}]"
  end

  def variable_id(file, name, scope_name) do
    "#{file}->VARIABLE->#{name}[in:#{scope_name}]"
  end

  def call_id(file, name, scope_name, line, col) do
    "#{file}->CALL->#{name}[in:#{scope_name},h:#{line}:#{col}]"
  end

  def import_id(file, target, scope_name) do
    "#{file}->IMPORT->#{target}[in:#{scope_name}]"
  end

  def export_id(file, name, arity, module_name) do
    "#{file}->EXPORT->#{name}/#{arity}[in:#{module_name}]"
  end

  def branch_id(file, kind, scope_name, line, col) do
    "#{file}->BRANCH->#{kind}[in:#{scope_name},h:#{line}:#{col}]"
  end

  def loop_id(file, scope_name, line, col) do
    "#{file}->LOOP->for[in:#{scope_name},h:#{line}:#{col}]"
  end

  def pattern_id(file, scope_name, line, col) do
    "#{file}->PATTERN->match[in:#{scope_name},h:#{line}:#{col}]"
  end

  def typespec_id(file, name, module_name) do
    "#{file}->TYPESPEC->#{name}[in:#{module_name}]"
  end
end
