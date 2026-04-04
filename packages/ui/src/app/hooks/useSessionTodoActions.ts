import { useCallback } from 'react';
import { addTodo, toggleTodo, type AgentTodo } from '../../lib/api';
import { toErrorMessage } from './useSessionActions.helpers';

type Params = {
  selectedSessionId: string;
  setErrorMessage: (message: string) => void;
  setTodos: (items: AgentTodo[]) => void;
};

export function useSessionTodoActions({ selectedSessionId, setErrorMessage, setTodos }: Params) {
  const handleAddTodo = useCallback(async (todoInput: string, setTodoInput: (value: string) => void) => {
    if (!selectedSessionId || !todoInput.trim()) return;
    const text = todoInput;
    setTodoInput('');
    setErrorMessage('');
    try {
      const response = await addTodo(selectedSessionId, text);
      setTodos(response.todos);
    } catch (error) {
      setTodoInput(text);
      setErrorMessage(toErrorMessage(error));
    }
  }, [selectedSessionId, setErrorMessage, setTodos]);

  const handleToggleTodo = useCallback(async (todo: AgentTodo) => {
    if (!selectedSessionId) return;
    setErrorMessage('');
    try {
      const response = await toggleTodo(selectedSessionId, todo.id, !todo.done);
      setTodos(response.todos);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [selectedSessionId, setErrorMessage, setTodos]);

  return { handleAddTodo, handleToggleTodo };
}