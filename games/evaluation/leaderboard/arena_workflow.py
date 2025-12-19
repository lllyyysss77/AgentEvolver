# -*- coding: utf-8 -*-
"""Arena workflows that randomly assign models to roles for different games."""
import random
import copy
from typing import Dict, Any, Type

from games.games.avalon.workflows.eval_workflow import EvalAvalonWorkflow


# Arena workflow registry
ARENA_WORKFLOW_REGISTRY: Dict[str, Type] = {}


def register_arena_workflow(game_name: str):
    """Decorator to register an arena workflow class."""
    def decorator(workflow_class: Type):
        ARENA_WORKFLOW_REGISTRY[game_name] = workflow_class
        return workflow_class
    return decorator


class ArenaAvalonWorkflow(EvalAvalonWorkflow):
    """Arena workflow that randomly assigns models to roles each game."""
    
    def __init__(self, config_dict: Dict[str, Any]):
        """Initialize arena workflow.
        
        Args:
            config_dict: Configuration dictionary. Must contain 'arena' key with:
                - models: List of model names to use
                - seed: Optional random seed for reproducibility
        """
        # Extract arena config
        arena_config = config_dict.get('arena', {})
        self.arena_models = arena_config.get('models', [])
        if not self.arena_models:
            raise ValueError("arena.models must be specified in config")
        
        # Set random seed if provided
        seed = arena_config.get('seed')
        if seed is not None:
            random.seed(seed)
        
        # Store original config and modify roles for this game
        self.original_config = copy.deepcopy(config_dict)
        self._assign_models_to_roles(config_dict)
        
        # Initialize parent class with modified config
        super().__init__(config_dict)
    
    def _assign_models_to_roles(self, config_dict: Dict[str, Any]):
        """Assign models to roles with fairness consideration and diversity.
        
        This modifies config_dict['roles'] to map role names to models.
        The actual role names will be determined at game start by AvalonGameEnvironment.
        We pre-assign models to indexed role positions (player_0, player_1, etc.)
        
        Prioritizes model diversity (no duplicates when possible):
        - If we have enough models, uses sampling without replacement
        - If we need more models than available, fills remaining slots with weighted random selection
        - Uses weighted random selection to ensure fair distribution:
          * Models with fewer games get higher weight
          * This helps balance game counts across models
        """
        # Get number of players
        game_config = config_dict.get('game', {})
        num_players = game_config.get('num_players', 5)
        
        # Get game counts for fairness (if available from leaderboard_db)
        game_counts = config_dict.get('_model_game_counts', {})
        
        # Calculate weights: inverse of game count (models with fewer games get higher weight)
        # Add 1 to avoid division by zero
        weights = [1.0 / (game_counts.get(model, 0) + 1) for model in self.arena_models]
        
        # Normalize weights
        total_weight = sum(weights)
        if total_weight > 0:
            weights = [w / total_weight for w in weights]
        else:
            # Equal weights if no game counts available
            weights = [1.0 / len(self.arena_models)] * len(self.arena_models)
        
        # Prioritize diversity: use sampling without replacement when possible
        if len(self.arena_models) >= num_players:
            # We have enough models, use weighted sampling without replacement
            # Create a list of (model, weight) pairs and sort by weight (descending)
            model_weight_pairs = list(zip(self.arena_models, weights))
            # Shuffle to add randomness while respecting weights
            random.shuffle(model_weight_pairs)
            # Sort by weight (descending) to prioritize models with fewer games
            model_weight_pairs.sort(key=lambda x: x[1], reverse=True)
            # Take first num_players models (diverse selection)
            assigned_models = [model for model, _ in model_weight_pairs[:num_players]]
            # Shuffle the assignment to randomize positions
            random.shuffle(assigned_models)
        else:
            # Not enough models, first assign all unique models, then fill remaining
            assigned_models = list(self.arena_models)  # Start with all models
            remaining = num_players - len(assigned_models)
            if remaining > 0:
                # Fill remaining slots with weighted random selection (with replacement)
                additional = random.choices(self.arena_models, weights=weights, k=remaining)
                assigned_models.extend(additional)
                # Shuffle to randomize positions
                random.shuffle(assigned_models)
        
        # Create roles config mapping
        # We'll map to indexed roles that will be created by RoleManager
        # The actual role names (Merlin, Servant, etc.) are assigned randomly by the game
        # So we map to player positions that will be converted to indexed roles
        roles_config = {}
        
        # Map models to player positions
        # The role names will be determined at runtime, but we can use a pattern
        # that matches how RoleManager creates indexed roles
        for i, model in enumerate(assigned_models):
            # Store model assignment in a way that can be retrieved later
            # We'll use player position as key, and the actual role matching
            # will happen in _get_model_config override
            roles_config[f'player_{i}'] = {'model_name': model}
        
        # Also store the assignment for later retrieval
        config_dict['_arena_model_assignment'] = assigned_models
        
        # Update roles config
        if 'roles' not in config_dict or config_dict['roles'] is None:
            config_dict['roles'] = {}
        config_dict['roles'].update(roles_config)
    
    def _get_model_config(self, indexed_role: str, base_role: str) -> Dict[str, Any]:
        """Override to get model from arena assignment.
        
        The indexed_role will be like "Merlin_0", "Servant_0", etc.
        We need to map this back to the player position.
        """
        # Get the arena model assignment
        assigned_models = self.config_dict.get('_arena_model_assignment', [])
        
        # Try to extract player index from indexed_role or base_role
        # indexed_role format: "RoleName_0", "RoleName_1", etc.
        # We need to find which player position this role corresponds to
        if not assigned_models:
            # Fallback to parent method
            return super()._get_model_config(indexed_role, base_role)
        
        # Get role manager to find player index
        if self.role_manager is None:
            # Role manager not initialized yet, use parent method
            return super()._get_model_config(indexed_role, base_role)
        
        # Find player index for this role
        player_index = None
        for i in range(len(assigned_models)):
            if self.role_manager.get_indexed_role(i) == indexed_role:
                player_index = i
                break
        
        if player_index is not None and player_index < len(assigned_models):
            # Get model name from assignment
            model_name = assigned_models[player_index]
            
            # Build config with this model
            default_model = self.config_dict.get('default_model', {})
            config = copy.deepcopy({**default_model})
            config['model_name'] = model_name
            return config
        
        # Fallback to parent method
        return super()._get_model_config(indexed_role, base_role)
    
    async def _execute_async(self) -> Dict[str, Any]:
        """Execute game and add model information to results."""
        result = await super()._execute_async()
        
        # Add model assignment to result for leaderboard calculation
        assigned_models = self.config_dict.get('_arena_model_assignment', [])
        if assigned_models and 'roles' in result:
            # Add model_name to each role in results
            for i, role_info in enumerate(result['roles']):
                if i < len(assigned_models):
                    role_info['model_name'] = assigned_models[i]
        
        return result


# Register Avalon arena workflow
register_arena_workflow("avalon")(ArenaAvalonWorkflow)


# Diplomacy arena workflow (lazy-loaded to avoid import issues)
def _register_diplomacy_workflow():
    """Register Diplomacy arena workflow (lazy-loaded)."""
    from games.games.diplomacy.workflows.eval_workflow import EvalDiplomacyWorkflow
    
    class ArenaDiplomacyWorkflow(EvalDiplomacyWorkflow):
        """Arena workflow for Diplomacy that randomly assigns models to powers."""
        
        def __init__(self, config_dict: Dict[str, Any]):
            """Initialize arena workflow.
            
            Args:
                config_dict: Configuration dictionary. Must contain 'arena' key with:
                    - models: List of model names to use
                    - seed: Optional random seed for reproducibility
            """
            # Extract arena config
            arena_config = config_dict.get('arena', {})
            self.arena_models = arena_config.get('models', [])
            if not self.arena_models:
                raise ValueError("arena.models must be specified in config")
            
            # Set random seed if provided
            seed = arena_config.get('seed')
            if seed is not None:
                random.seed(seed)
            
            # Store original config and modify roles for this game
            self.original_config = copy.deepcopy(config_dict)
            self._assign_models_to_powers(config_dict)
            
            # Initialize parent class with modified config
            super().__init__(config_dict)
        
        def _assign_models_to_powers(self, config_dict: Dict[str, Any]):
            """Assign models to powers with fairness consideration and diversity.
            
            This modifies config_dict['roles'] to map power names to models.
            
            Prioritizes model diversity (no duplicates when possible):
            - If we have enough models, uses sampling without replacement
            - If we need more models than available, fills remaining slots with weighted random selection
            - Uses weighted random selection to ensure fair distribution.
            """
            game_config = config_dict.get('game', {})
            power_names = game_config.get('power_names', ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"])
            num_powers = len(power_names)
            
            # Get game counts for fairness (if available from leaderboard_db)
            game_counts = config_dict.get('_model_game_counts', {})
            
            # Calculate weights: inverse of game count (models with fewer games get higher weight)
            # Add 1 to avoid division by zero
            weights = [1.0 / (game_counts.get(model, 0) + 1) for model in self.arena_models]
            
            # Normalize weights
            total_weight = sum(weights)
            if total_weight > 0:
                weights = [w / total_weight for w in weights]
            else:
                # Equal weights if no game counts available
                weights = [1.0 / len(self.arena_models)] * len(self.arena_models)
            
            # Prioritize diversity: use sampling without replacement when possible
            if len(self.arena_models) >= num_powers:
                # We have enough models, use weighted sampling without replacement
                # Create a list of (model, weight) pairs and sort by weight (descending)
                model_weight_pairs = list(zip(self.arena_models, weights))
                # Shuffle to add randomness while respecting weights
                random.shuffle(model_weight_pairs)
                # Sort by weight (descending) to prioritize models with fewer games
                model_weight_pairs.sort(key=lambda x: x[1], reverse=True)
                # Take first num_powers models (diverse selection)
                assigned_models = [model for model, _ in model_weight_pairs[:num_powers]]
                # Shuffle the assignment to randomize positions
                random.shuffle(assigned_models)
            else:
                # Not enough models, first assign all unique models, then fill remaining
                assigned_models = list(self.arena_models)  # Start with all models
                remaining = num_powers - len(assigned_models)
                if remaining > 0:
                    # Fill remaining slots with weighted random selection (with replacement)
                    additional = random.choices(self.arena_models, weights=weights, k=remaining)
                    assigned_models.extend(additional)
                    # Shuffle to randomize positions
                    random.shuffle(assigned_models)
            
            # Create roles config mapping power names to models
            roles_config = {}
            for power_name, model in zip(power_names, assigned_models):
                roles_config[power_name] = {'model_name': model}
            
            # Store the assignment for later retrieval
            config_dict['_arena_model_assignment'] = dict(zip(power_names, assigned_models))
            
            # Update roles config
            if 'roles' not in config_dict or config_dict['roles'] is None:
                config_dict['roles'] = {}
            config_dict['roles'].update(roles_config)
        
        async def _execute_async(self) -> Dict[str, Any]:
            """Execute game and add model information to results."""
            result = await super()._execute_async()
            
            # Add model assignment to result for leaderboard calculation
            assigned_models = self.config_dict.get('_arena_model_assignment', {})
            if assigned_models and 'roles' in result:
                # Add model_name to each role in results
                for role_info in result['roles']:
                    power_name = role_info.get('role_name', '')
                    if power_name in assigned_models:
                        role_info['model_name'] = assigned_models[power_name]
            
            return result
    
    register_arena_workflow("diplomacy")(ArenaDiplomacyWorkflow)
    return ArenaDiplomacyWorkflow


# Lazy load Diplomacy workflow when needed
def _ensure_diplomacy_registered():
    """Ensure Diplomacy workflow is registered (lazy loading)."""
    if "diplomacy" not in ARENA_WORKFLOW_REGISTRY:
        _register_diplomacy_workflow()


def create_arena_workflow(game_name: str, config_dict: Dict[str, Any]):
    """Factory function to create arena workflow for a game.
    
    Args:
        game_name: Name of the game (e.g., 'avalon', 'diplomacy')
        config_dict: Configuration dictionary
    
    Returns:
        Arena workflow instance
    
    Raises:
        ValueError: If game_name is not registered
    """
    # Lazy load Diplomacy if needed
    if game_name == "diplomacy":
        _ensure_diplomacy_registered()
    
    if game_name not in ARENA_WORKFLOW_REGISTRY:
        available = ', '.join(ARENA_WORKFLOW_REGISTRY.keys())
        raise ValueError(
            f"Game '{game_name}' not found in arena registry. "
            f"Available games: {available}"
        )
    
    workflow_class = ARENA_WORKFLOW_REGISTRY[game_name]
    return workflow_class(config_dict=config_dict)

